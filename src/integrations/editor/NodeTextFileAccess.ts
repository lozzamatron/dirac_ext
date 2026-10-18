import { isUtf8 } from "node:buffer"

import * as fs from "fs/promises"
import * as iconv from "iconv-lite"
import { detectEncoding } from "../misc/extract-text"
import type { TextFileAccess, TextFileReadResult, TextFileWriteResult } from "./TextFileAccess"

export class NodeTextFileAccess implements TextFileAccess {
	async readText(path: string): Promise<TextFileReadResult> {
		const fileBuffer = await fs.readFile(path)
		// Valid UTF-8 must not be reinterpreted as a legacy encoding by a statistical detector.
		// UTF-16 files (including those without a BOM) contain NULs and still need detection.
		const encoding = isUtf8(fileBuffer) && !fileBuffer.includes(0) ? "utf8" : await detectEncoding(fileBuffer)
		return {
			content: iconv.decode(fileBuffer, encoding),
			encoding,
		}
	}

	async writeText(path: string, content: string): Promise<TextFileWriteResult> {
		await fs.writeFile(path, content, { encoding: "utf8" })
		return { content }
	}
}
