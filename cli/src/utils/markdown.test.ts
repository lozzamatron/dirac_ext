import stripAnsi from "strip-ansi"
import stringWidth from "string-width"
import { describe, expect, it } from "vitest"
import { clipMarkdownLines, renderMarkdownLines } from "./markdown"

const plainRows = (markdown: string, width: number) => renderMarkdownLines(markdown, width).map(stripAnsi)

describe("formatted Markdown row windows", () => {
	it("retains code and prose across multiple backtick and tilde fences", () => {
		const markdown = "```js\n**literal**\nsecond\n```\n\n**Prose**\n\n~~~~text\n~~~\nlast\n~~~~"
		const lines = renderMarkdownLines(markdown, 30)
		const plain = lines.map(stripAnsi)
		expect(plain).toContain("│ **literal** │")
		expect(plain).toContain("Prose")
		expect(plain.some((line) => line.includes("│ ~~~"))).toBe(true)
		for (let offset = 0; offset <= lines.length - 2; offset++) {
			const clipped = clipMarkdownLines(lines, 2, offset)
			expect(clipped.visibleText.split("\n").map(stripAnsi)).toEqual(
				plain.slice(lines.length - offset - 2, lines.length - offset),
			)
		}
	})

	it("preserves table borders, list numbering, blockquotes and reference links without reparsing slices", () => {
		const rows = plainRows(
			"7. first\n8. second\n\n> quoted **text**\n\n| Head | Next |\n| --- | --- |\n| a | b |\n\n[reference][id]\n\n[id]: https://example.com",
			40,
		)
		expect(rows.join("\n")).toContain("7. first")
		expect(rows.join("\n")).toContain("8. second")
		expect(rows.join("\n")).toContain("│ quoted text")
		expect(rows.join("\n")).toContain("reference (https://example.com)")
		expect(rows.some((line) => line.startsWith("├"))).toBe(true)
	})

	it.each([1, 4, 10, 20])("wraps CRLF, long code, and Unicode within %i terminal cells", (width) => {
		const rows = plainRows(
			"```text\r\n" + "界🙂e\u0301".repeat(9) + "\r\n```\r\n\r\n**long prose** " + "word ".repeat(15),
			width,
		)
		// A wide grapheme is indivisible even when the terminal is only one cell wide.
		for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(Math.max(2, width))
		expect(rows.join("\n")).not.toContain("\r")
		expect(rows.join("\n")).not.toContain("\uFFFD")
	})

	it("clamps offsets and reports the same row bounds used for scrolling", () => {
		const rows = renderMarkdownLines("one\ntwo\nthree\nfour", 20)
		expect(clipMarkdownLines(rows, 2, -10)).toMatchObject({
			visibleText: "three\nfour",
			hasMoreAbove: true,
			hasMoreBelow: false,
		})
		expect(clipMarkdownLines(rows, 2, 100)).toMatchObject({
			visibleText: "one\ntwo",
			hasMoreAbove: false,
			hasMoreBelow: true,
		})
		expect(clipMarkdownLines(rows, 10)).toMatchObject({ hasMoreAbove: false, hasMoreBelow: false })
	})
})
