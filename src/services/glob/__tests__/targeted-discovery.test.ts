import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { findFilesByName, listFiles } from "../list-files"

const git = promisify(execFile)

describe("targeted rule and file discovery", () => {
	let root: string
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-discovery-"))
		await git("git", ["init", "-q", root])
	})
	afterEach(async () => {
		sinon.restore()
		await fs.rm(root, { recursive: true, force: true })
	})

	it("finds rules beyond 500 files without reading unrelated file contents, and sees new rules immediately", async () => {
		await Promise.all(Array.from({ length: 520 }, (_, index) => fs.writeFile(path.join(root, `f${index}.txt`), "unrelated")))
		await fs.mkdir(path.join(root, "nested"))
		await fs.writeFile(path.join(root, "AGENTS.md"), "root rules")
		await fs.writeFile(path.join(root, "nested", "agents.md"), "nested rules")
		const read = sinon.spy(require("node:fs/promises"), "readFile")
		assert.equal((await findFilesByName(root, "AGENTS.md")).length, 2)
		assert.equal(read.callCount, 0)
		await fs.mkdir(path.join(root, "new"))
		await fs.writeFile(path.join(root, "new", "AGENTS.md"), "new rules")
		assert.equal((await findFilesByName(root, "AGENTS.md")).length, 3)
	})

	it("loads Git ignore policy even when hidden files are omitted, including non-recursive listing", async () => {
		await fs.mkdir(path.join(root, "ascratch", "deep"), { recursive: true })
		await fs.writeFile(path.join(root, ".gitignore"), "ascratch/\n")
		await fs.writeFile(path.join(root, "visible.txt"), "one\ntwo")
		const open = sinon.spy(require("node:fs/promises"), "opendir")
		for (const recursive of [false, true]) {
			const [files] = await listFiles(root, recursive, 500)
			assert.deepEqual(
				files.map((file) => path.basename(file.path)),
				["visible.txt"],
			)
			assert.equal(files[0].lineCount, 2)
		}
		assert(!open.getCalls().some((call) => String(call.args[0]).includes("ascratch")))
	})
	it("allows explicit ignored directories and stops at symlink cycles", async () => {
		await fs.mkdir(path.join(root, "ignored"))
		await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n")
		await fs.writeFile(path.join(root, "ignored", "keep.txt"), "explicit")
		await fs.symlink(root, path.join(root, "ignored", "loop"), "dir")
		const [files, limited] = await listFiles(path.join(root, "ignored"), true, 500)
		assert.equal(limited, false)
		assert.deepEqual(files.map((file) => path.basename(file.path)).sort(), ["keep.txt", "loop"])
	})
	it("still discovers files and honors local ignores when Git is unavailable", async () => {
		await fs.mkdir(path.join(root, "ignored"))
		await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n")
		await fs.writeFile(path.join(root, "AGENTS.md"), "root rules")
		await fs.writeFile(path.join(root, "ignored", "AGENTS.md"), "ignored rules")
		const previousPath = process.env.PATH
		process.env.PATH = ""
		try {
			assert.deepEqual(await findFilesByName(root, "AGENTS.md"), [path.join(root, "AGENTS.md")])
			assert.equal((await listFiles(root, true, 500))[0].length, 1)
		} finally {
			process.env.PATH = previousPath
		}
	})

})
