import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"])

/**
 * Check if a file path is an image based on extension
 */
export function isImagePath(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase()
	return IMAGE_EXTENSIONS.has(ext)
}

/**
 * Get MIME type for an image extension
 */
function getMimeType(ext: string): string {
	const mimeTypes: Record<string, string> = {
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".webp": "image/webp",
	}
	const mimeType = mimeTypes[ext.toLowerCase()]
	if (!mimeType) throw new Error(`Unsupported image extension: ${ext}`)
	return mimeType
}

/**
 * Convert an image file path to a base64 data URL
 */
export async function imageFileToDataUrl(filePath: string): Promise<string> {
	const resolvedPath = path.resolve(filePath)
	const ext = path.extname(resolvedPath).toLowerCase()
	if (!IMAGE_EXTENSIONS.has(ext)) throw new Error(`Unsupported image type: ${filePath}`)
	const mimeType = getMimeType(ext)

	const buffer = await fs.promises.readFile(resolvedPath)
	const base64 = buffer.toString("base64")

	return `data:${mimeType};base64,${base64}`
}

/**
 * Parse input text and extract image file paths.
 * Supports workspace mentions like "prompt text @/path/to/image.png" and ordinary file paths.
 * Returns the clean prompt text and array of image paths
 */
/**
 * Expand ~ to home directory
 */
function expandHome(p: string): string {
	if (p.startsWith("~/") || p === "~") {
		return path.join(os.homedir(), p.slice(1))
	}
	return p
}

function unescapePath(p: string): string {
	if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
		return p.slice(1, -1)
	}
	// Handle backslash-escaped spaces and other common terminal escapes
	return p.replace(/\\(.)/g, "$1")
}

interface ImagePathCandidate {
	attachmentPath: string
	resolvedPath: string
}

function resolveImagePathCandidate(
	pathText: string,
	baseDirectory: string,
	isWorkspaceMention: boolean,
): ImagePathCandidate {
	const unescapedPath = unescapePath(pathText)
	const attachmentPath = isWorkspaceMention && unescapedPath.startsWith("/") ? unescapedPath.slice(1) : unescapedPath
	return {
		attachmentPath,
		resolvedPath: path.resolve(baseDirectory, expandHome(attachmentPath)),
	}
}

function findExistingImagePath(
	pathText: string,
	baseDirectory: string,
	isWorkspaceMention: boolean,
): ImagePathCandidate | null {
	const candidate = resolveImagePathCandidate(pathText, baseDirectory, isWorkspaceMention)
	return fs.existsSync(candidate.resolvedPath) ? candidate : null
}

function removeImageReferences(input: string, references: Array<{ start: number; end: number }>): string {
	let prompt = input
	for (const { start, end } of references.sort((left, right) => right.start - left.start)) {
		let left = start
		let right = end
		while (left > 0 && /[ \t]/.test(prompt[left - 1])) left--
		while (right < prompt.length && /[ \t]/.test(prompt[right])) right++
		const before = prompt[left - 1]
		const after = prompt[right]
		const separator = before && after && !/[\r\n]/.test(before + after) ? " " : ""
		prompt = prompt.slice(0, left) + separator + prompt.slice(right)
	}
	return prompt
}

export function parseImagesFromInput(input: string, baseDirectory = process.cwd()): { prompt: string; imagePaths: string[] } {
	const imagePaths: string[] = []
	const resolvedImagePaths = new Set<string>()
	const imageReferences: Array<{ start: number; end: number }> = []

	// Match @path/to/image.ext patterns (with space or at start)
	// Supports: @/workspace/path, @./rel/path, @path/to/file, @C:\path\to\file, @~/path
	// Also supports quoted paths and escaped spaces
	const atPathPattern =
		/@(?:"([^"]+\.(?:png|jpg|jpeg|gif|webp))"|'([^']+\.(?:png|jpg|jpeg|gif|webp))'|((?:[a-zA-Z]:\\|\/|\.\/|\.\.\/|~|[^\s@])(?:[^\s]|\\ )*?\.(?:png|jpg|jpeg|gif|webp)))/gi

	// Match standalone paths that look like images
	// Stricter for unquoted paths: must start with /, ./, ../, ~/, or drive letter
	const standalonePathPattern =
		/(?:^|[ \t\n\r\f\v])(?:"([^"]+\.(?:png|jpg|jpeg|gif|webp))"|'([^']+\.(?:png|jpg|jpeg|gif|webp))'|((?:[a-zA-Z]:\\|\/|\.\/|\.\.\/|~)(?:[^ \t\n\r\f\v]|\\ )*?\.(?:png|jpg|jpeg|gif|webp)))(?=[ \t\n\r\f\v]|$)/gi

	let match: RegExpExecArray | null

	// First pass: find all potential image paths that actually exist
	while ((match = atPathPattern.exec(input)) !== null) {
		const p = match[1] || match[2] || match[3]
		if (!p) continue
		const candidate = findExistingImagePath(p, baseDirectory, true)
		if (!candidate) continue
		if (!resolvedImagePaths.has(candidate.resolvedPath)) {
			resolvedImagePaths.add(candidate.resolvedPath)
			imagePaths.push(candidate.attachmentPath)
		}
		imageReferences.push({ start: match.index, end: match.index + match[0].length })
	}

	while ((match = standalonePathPattern.exec(input)) !== null) {
		const p = match[1] || match[2] || match[3]
		if (!p) continue
		const candidate = findExistingImagePath(p, baseDirectory, false)
		if (!candidate) continue
		if (!resolvedImagePaths.has(candidate.resolvedPath)) {
			resolvedImagePaths.add(candidate.resolvedPath)
			imagePaths.push(candidate.attachmentPath)
		}
		const prefixLength = /^[ \t\n\r\f\v]/.test(match[0]) ? 1 : 0
		imageReferences.push({ start: match.index + prefixLength, end: match.index + match[0].length })
	}

	// Preserve every unrelated byte, including indentation inside quoted code examples.
	const prompt = removeImageReferences(input, imageReferences)

	return { prompt, imagePaths }
}

/**
 * Parse headers string into a Record<string, string>.
 * Supports comma-separated key=value pairs or JSON.
 * Example: "X-Header=Value,Authorization=Bearer token" or '{"X-Header": "Value"}'
 */
export function parseHeaders(headersString: string): Record<string, string> {
	const trimmed = headersString.trim()
	if (trimmed.startsWith("{")) {
		const parsed: unknown = JSON.parse(trimmed)
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("Custom headers JSON must be an object")
		}
		for (const [key, value] of Object.entries(parsed)) {
			if (!key.trim() || typeof value !== "string") {
				throw new Error("Custom header names and values must be strings")
			}
		}
		return parsed as Record<string, string>
	}

	const headers: Record<string, string> = {}
	const pairs = trimmed.split(",")
	for (const pair of pairs) {
		const [key, ...valueParts] = pair.split("=")
		if (!key?.trim() || valueParts.length === 0) throw new Error(`Invalid custom header: ${pair}`)
		headers[key.trim()] = valueParts.join("=").trim()
	}
	return headers
}

/**
 * Process image file paths into base64 data URLs
 * Rejects invalid or unreadable paths so callers can preserve the user's draft and report the failure.
 */
export async function processImagePaths(imagePaths: string[], baseDirectory = process.cwd()): Promise<string[]> {
	const dataUrls: string[] = []
	const processedPaths = new Set<string>()

	for (const imagePath of imagePaths) {
		const expandedPath = expandHome(imagePath)
		const resolvedPath = path.resolve(baseDirectory, expandedPath)
		if (!fs.existsSync(resolvedPath)) throw new Error(`Image file not found: ${imagePath}`)
		if (!isImagePath(resolvedPath)) throw new Error(`Unsupported image type: ${imagePath}`)
		const pathKey = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath
		if (processedPaths.has(pathKey)) continue
		processedPaths.add(pathKey)
		const dataUrl = await imageFileToDataUrl(resolvedPath)
		dataUrls.push(dataUrl)
	}

	return dataUrls
}
