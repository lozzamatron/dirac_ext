import fs from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	imageFileToDataUrl,
	isImagePath,
	parseHeaders,
	parseImagesFromInput,
	processImagePaths,
} from "./parser"

describe("parser", () => {
	describe("isImagePath", () => {
		it("should return true for .png files", () => {
			expect(isImagePath("/path/to/image.png")).toBe(true)
		})

		it("should return true for .jpg files", () => {
			expect(isImagePath("/path/to/image.jpg")).toBe(true)
		})

		it("should return true for .jpeg files", () => {
			expect(isImagePath("/path/to/image.jpeg")).toBe(true)
		})

		it("should return true for .gif files", () => {
			expect(isImagePath("/path/to/image.gif")).toBe(true)
		})

		it("should return true for .webp files", () => {
			expect(isImagePath("/path/to/image.webp")).toBe(true)
		})

		it("should return false for non-image files", () => {
			expect(isImagePath("/path/to/file.txt")).toBe(false)
			expect(isImagePath("/path/to/file.pdf")).toBe(false)
			expect(isImagePath("/path/to/file.js")).toBe(false)
		})

		it("should handle uppercase extensions", () => {
			expect(isImagePath("/path/to/image.PNG")).toBe(true)
			expect(isImagePath("/path/to/image.JPG")).toBe(true)
		})

		it("should handle mixed case extensions", () => {
			expect(isImagePath("/path/to/image.Png")).toBe(true)
		})
	})

	describe("parseHeaders", () => {
		it("parses JSON and comma-separated headers", () => {
			expect(parseHeaders('{"Authorization":"Bearer token"}')).toEqual({ Authorization: "Bearer token" })
			expect(parseHeaders("X-One=one,Authorization=Bearer token=extra")).toEqual({
				"X-One": "one",
				Authorization: "Bearer token=extra",
			})
		})

		it("rejects malformed JSON and malformed pairs", () => {
			expect(() => parseHeaders('{"broken"')).toThrow()
			expect(() => parseHeaders("missing-value")).toThrow("Invalid custom header")
		})

		it("rejects non-string JSON values", () => {
			expect(() => parseHeaders('{"X-Retries":3}')).toThrow("must be strings")
		})
	})

	describe("parseImagesFromInput", () => {
		beforeEach(() => {
			vi.spyOn(fs, "existsSync").mockReturnValue(true)
		})

		afterEach(() => {
			vi.restoreAllMocks()
		})

		it("should extract image paths with @ prefix", () => {
			const input = "analyze this image @/path/to/image.png"
			const result = parseImagesFromInput(input)
			expect(result.imagePaths).toContain("path/to/image.png")
			expect(result.prompt).toBe("analyze this image")
		})

		it("should resolve slash-prefixed mentions from the workspace", () => {
			const input = "analyze @/images/image.png"
			const result = parseImagesFromInput(input, "/workspace")

			expect(fs.existsSync).toHaveBeenCalledWith("/workspace/images/image.png")
			expect(result.imagePaths).toEqual(["images/image.png"])
		})

		it("should extract multiple images", () => {
			const input = "compare @/img1.png and @/img2.jpg"
			const result = parseImagesFromInput(input)
			expect(result.imagePaths).toContain("img1.png")
			expect(result.imagePaths).toContain("img2.jpg")
		})

		it("should handle standalone image paths", () => {
			const input = "look at /path/to/image.png please"
			const result = parseImagesFromInput(input)
			expect(result.imagePaths).toContain("/path/to/image.png")
		})

		it("should return empty array when no images", () => {
			const input = "just some text without images"
			const result = parseImagesFromInput(input)
			expect(result.imagePaths).toEqual([])
			expect(result.prompt).toBe("just some text without images")
		})

		it("preserves exact whitespace in prompts without image references", () => {
			const input = 'Insert exactly "  expect(value).toBe(true);\\n"\n    { nested: true }\n'
			const result = parseImagesFromInput(input)
			expect(result).toEqual({ prompt: input, imagePaths: [] })
		})

		it("should handle image at start of input", () => {
			const input = "@/start.png is the image"
			const result = parseImagesFromInput(input)
			expect(result.imagePaths).toContain("start.png")
		})

		it("should handle all supported image extensions", () => {
			const input = "@/a.png @/b.jpg @/c.jpeg @/d.gif @/e.webp"
			const result = parseImagesFromInput(input)
			expect(result.imagePaths).toHaveLength(5)
		})

		it("should not duplicate image paths", () => {
			const input = "@/same.png @\"/same.png\""
			const result = parseImagesFromInput(input)
			expect(result.imagePaths).toEqual(["same.png"])
		})

		it("should clean up extra whitespace in prompt", () => {
			const input = "text   @/image.png   more text"
			const result = parseImagesFromInput(input)
			expect(result.prompt).toBe("text more text")
		})

		it("only cleans whitespace around removed image references", () => {
			const input = 'Keep "  indent" and  two spaces\n    code();\ntext   @/image.png   more text'
			const result = parseImagesFromInput(input)
			expect(result.prompt).toBe('Keep "  indent" and  two spaces\n    code();\ntext more text')
		})

		it("should handle paths with narrow non-breaking spaces (macOS screenshots)", () => {
			const input = "/Users/max/Desktop/Screenshot\\ 2026-05-05\\ at\\ 4.08.14\u202fPM.png what is this image"
			const result = parseImagesFromInput(input)
			expect(result.imagePaths).toContain("/Users/max/Desktop/Screenshot 2026-05-05 at 4.08.14\u202fPM.png")
			expect(result.prompt).toBe("what is this image")
		})

		it("should handle multiple consecutive standalone image paths", () => {
			const input = "/img1.png /img2.jpg"
			const result = parseImagesFromInput(input)
			expect(result.imagePaths).toContain("/img1.png")
			expect(result.imagePaths).toContain("/img2.jpg")
			expect(result.prompt).toBe("")
		})

		it("should handle quoted paths with spaces and narrow non-breaking spaces", () => {
			const input = 'analyze @"/path with spaces/Screenshot\u202fPM.png"'
			const result = parseImagesFromInput(input)
			expect(result.imagePaths).toContain("path with spaces/Screenshot\u202fPM.png")
			expect(result.prompt).toBe("analyze")
		})

		it("should not extract image paths that do not exist", () => {
			vi.mocked(fs.existsSync).mockReturnValue(false)
			const input = "analyze this image @/nonexistent/image.png"
			const result = parseImagesFromInput(input)
			expect(result.imagePaths).toEqual([])
			expect(result.prompt).toBe("analyze this image @/nonexistent/image.png")
		})

		it("preserves whitespace when an image reference does not resolve", () => {
			vi.mocked(fs.existsSync).mockReturnValue(false)
			const input = 'Insert "  two spaces" @/missing.png\n  code();'
			expect(parseImagesFromInput(input)).toEqual({ prompt: input, imagePaths: [] })
		})

		it("should handle ~ in paths", () => {
			const input = "analyze @~/image.png"
			const result = parseImagesFromInput(input)
			expect(result.imagePaths).toContain("~/image.png")
			expect(result.prompt).toBe("analyze")
		})

		it("should handle relative paths in quotes", () => {
			const input = 'analyze "Desktop/image.png"'
			const result = parseImagesFromInput(input)
			expect(result.imagePaths).toContain("Desktop/image.png")
			expect(result.prompt).toBe("analyze")
		})

		it("should not match standalone paths that do not start with path-like characters", () => {
			const input = "this is not a path: image.png"
			const result = parseImagesFromInput(input)
			expect(result.imagePaths).toEqual([])
			expect(result.prompt).toBe("this is not a path: image.png")
		})

		it("should match standalone paths starting with ./", () => {
			const input = "this is a path: ./image.png"
			const result = parseImagesFromInput(input)
			expect(result.imagePaths).toContain("./image.png")
			expect(result.prompt).toBe("this is a path:")
		})
	})

	describe("imageFileToDataUrl", () => {
		beforeEach(() => {
			vi.spyOn(fs.promises, "readFile")
		})

		afterEach(() => {
			vi.restoreAllMocks()
		})

		it("should convert png to data URL", async () => {
			const mockBuffer = Buffer.from("fake png data")
			vi.mocked(fs.promises.readFile).mockResolvedValue(mockBuffer)

			const result = await imageFileToDataUrl("/path/to/image.png")

			expect(result).toMatch(/^data:image\/png;base64,/)
			expect(result).toContain(mockBuffer.toString("base64"))
		})

		it("should use correct MIME type for jpeg", async () => {
			const mockBuffer = Buffer.from("fake jpeg data")
			vi.mocked(fs.promises.readFile).mockResolvedValue(mockBuffer)

			const result = await imageFileToDataUrl("/path/to/image.jpg")

			expect(result).toMatch(/^data:image\/jpeg;base64,/)
		})

		it("should use correct MIME type for gif", async () => {
			const mockBuffer = Buffer.from("fake gif data")
			vi.mocked(fs.promises.readFile).mockResolvedValue(mockBuffer)

			const result = await imageFileToDataUrl("/path/to/image.gif")

			expect(result).toMatch(/^data:image\/gif;base64,/)
		})

		it("should use correct MIME type for webp", async () => {
			const mockBuffer = Buffer.from("fake webp data")
			vi.mocked(fs.promises.readFile).mockResolvedValue(mockBuffer)

			const result = await imageFileToDataUrl("/path/to/image.webp")

			expect(result).toMatch(/^data:image\/webp;base64,/)
		})
	})

	describe("processImagePaths", () => {
		beforeEach(() => {
			vi.spyOn(fs, "existsSync")
			vi.spyOn(fs.promises, "readFile")
		})

		afterEach(() => {
			vi.restoreAllMocks()
		})

		it("should process existing image files", async () => {
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from("image data"))

			const result = await processImagePaths(["/path/to/image.png"])

			expect(result).toHaveLength(1)
			expect(result[0]).toMatch(/^data:image\/png;base64,/)
		})

		it("should reject non-existent files", async () => {
			vi.mocked(fs.existsSync).mockReturnValue(false)

			await expect(processImagePaths(["/nonexistent/image.png"])).rejects.toThrow("Image file not found")
		})

		it("should reject non-image files", async () => {
			vi.mocked(fs.existsSync).mockReturnValue(true)

			await expect(processImagePaths(["/path/to/file.txt"])).rejects.toThrow("Unsupported image type")
		})

		it("should process multiple images", async () => {
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from("image data"))

			const result = await processImagePaths(["/img1.png", "/img2.jpg", "/img3.gif"])

			expect(result).toHaveLength(3)
		})

		it("should process the same resolved image only once", async () => {
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from("image data"))

			const result = await processImagePaths(["images/a.png", "./images/a.png"], "/workspace")

			expect(result).toHaveLength(1)
			expect(fs.promises.readFile).toHaveBeenCalledTimes(1)
		})

		it("should report read errors", async () => {
			vi.mocked(fs.existsSync).mockReturnValue(true)
			vi.mocked(fs.promises.readFile).mockRejectedValue(new Error("Read error"))

			await expect(processImagePaths(["/path/to/image.png"])).rejects.toThrow("Read error")
		})

		it("should handle empty input", async () => {
			const result = await processImagePaths([])
			expect(result).toEqual([])
		})
	})
})
