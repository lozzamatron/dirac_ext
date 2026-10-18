import * as assert from "assert"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as iconv from "iconv-lite"
import { afterEach, beforeEach, describe, it } from "mocha"
import { NodeTextFileAccess } from "../NodeTextFileAccess"

describe("NodeTextFileAccess", () => {
	let directory: string
	const access = new NodeTextFileAccess()

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "node-text-file-access-"))
	})

	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("reads UTF-8 text with detected encoding", async () => {
		const filePath = path.join(directory, "utf8.txt")
		await fs.writeFile(filePath, "hello 🌍", "utf8")

		const result = await access.readText(filePath)
		assert.strictEqual(result.content, "hello 🌍")
		assert.ok(result.encoding.length > 0)
	})

	it("keeps valid UTF-8 after an escape character changes encoding detection", async () => {
		const filePath = path.join(directory, "escape.sh")
		const content =
			"# Checkout\u00a0policy\u2014cafe\u0301\u2060\nregister_route 'checkout-\u001b1' 'legacy\u200bCheckout' 3\n"
		await fs.writeFile(filePath, content, "utf8")

		const result = await access.readText(filePath)
		assert.strictEqual(result.content, content)
		assert.strictEqual(result.encoding, "utf8")
	})

	it("decodes UTF-16 text with a BOM", async () => {
		const filePath = path.join(directory, "utf16.txt")
		await fs.writeFile(filePath, iconv.encode("\ufeffhello \u00e9", "utf16le"))

		const result = await access.readText(filePath)
		assert.strictEqual(result.content, "hello \u00e9")
	})

	it("decodes supported non-UTF-8 text through existing encoding detection", async () => {
		const filePath = path.join(directory, "legacy.txt")
		await fs.writeFile(filePath, iconv.encode("olá señor", "windows-1252"))

		const result = await access.readText(filePath)
		assert.strictEqual(result.content, "olá señor")
		assert.ok(result.encoding.length > 0)
	})

	it("preserves empty reads and writes", async () => {
		const filePath = path.join(directory, "empty.txt")
		await fs.writeFile(filePath, "initial", "utf8")

		assert.deepStrictEqual(await access.writeText(filePath, ""), { content: "" })
		assert.strictEqual((await access.readText(filePath)).content, "")
	})

	it("writes UTF-8 content before returning", async () => {
		const filePath = path.join(directory, "write.txt")
		const result = await access.writeText(filePath, "written 🌍")

		assert.deepStrictEqual(result, { content: "written 🌍" })
		assert.strictEqual(await fs.readFile(filePath, "utf8"), "written 🌍")
	})

	it("rejects missing reads and failed writes", async () => {
		await assert.rejects(access.readText(path.join(directory, "missing.txt")))
		await assert.rejects(access.writeText(directory, "cannot write a directory"))
	})
})
