import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { walkWorkspace, WorkspaceGitVisibility } from "../workspaceTraversal"
import { readDirectory } from "../fs"

const git = promisify(execFile)

describe("pruned workspace traversal", () => {
	let root: string
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-traversal-"))
		await git("git", ["init", "-q", root])
	})
	afterEach(async () => {
		sinon.restore()
		await fs.rm(root, { recursive: true, force: true })
	})

	it("never opens ignored trees; retains tracked children and nested negations", async () => {
		for (const name of ["ascratch/deep", "tracked", "nested"]) await fs.mkdir(path.join(root, name), { recursive: true })
		await fs.writeFile(path.join(root, "tracked", "keep.ts"), "export const keep = 1")
		await git("git", ["-C", root, "add", "tracked/keep.ts"])
		await fs.writeFile(path.join(root, ".gitignore"), "ascratch/\ntracked/\n")
		await fs.writeFile(path.join(root, "nested", ".gitignore"), "*.ts\n!keep.ts\n")
		await fs.writeFile(path.join(root, "nested", "keep.ts"), "")
		await fs.writeFile(path.join(root, "nested", "drop.ts"), "")
		const open = sinon.spy(require("node:fs/promises"), "opendir")
		const files = []
		for await (const entry of walkWorkspace(root, {
			signal: AbortSignal.timeout(5_000),
			excludes: (entry) => entry.dirent.name.startsWith("."),
		}))
			files.push(entry.relativePath)
		assert(files.includes(path.join("tracked", "keep.ts")))
		assert(files.includes(path.join("nested", "keep.ts")))
		assert(!files.includes(path.join("nested", "drop.ts")))
		assert(!open.getCalls().some((call) => String(call.args[0]).includes("ascratch")))
	})

	it("skips Git checks for tracked-only batches while checking untracked paths", async () => {
		await fs.mkdir(path.join(root, "tracked"))
		const trackedFile = path.join("tracked", "keep.ts")
		await fs.writeFile(path.join(root, trackedFile), "")
		await git("git", ["-C", root, "add", trackedFile])
		await fs.writeFile(path.join(root, ".gitignore"), "tracked/\ndrop.ts\n")
		const visibility = await WorkspaceGitVisibility.create(root, AbortSignal.timeout(5_000))
		const execute = sinon.spy(require("node:child_process"), "execFile")
		assert.equal((await visibility.ignoredPaths(["tracked", trackedFile])).size, 0)
		assert.equal(execute.callCount, 0)
		assert.deepEqual(await visibility.ignoredPaths([trackedFile, "drop.ts"]), new Set(["drop.ts"]))
		assert.equal(execute.callCount, 1)
	})

	it("closes directory handles and stops discovery when cancelled or limited by the consumer", async () => {
		await fs.mkdir(path.join(root, "child"))
		await fs.symlink(root, path.join(root, "cycle"), "dir")
		const controller = new AbortController()
		const open = sinon.spy(require("node:fs/promises"), "opendir")
		const scan = walkWorkspace(root, { signal: controller.signal, gitVisibility: false })
		await scan.next()
		controller.abort(new Error("cancel scan"))
		await assert.rejects(scan.next(), /cancel scan/)
		const count = open.callCount
		await new Promise((resolve) => setTimeout(resolve, 30))
		assert.equal(open.callCount, count)
		for (const call of open.getCalls()) {
			const directory = await call.returnValue
			await assert.rejects(directory.read(), { code: "ERR_DIR_CLOSED" })
		}
	})

	it("does not descend into excluded directories in readDirectory", async () => {
		await fs.mkdir(path.join(root, "skip", "deep"), { recursive: true })
		await fs.writeFile(path.join(root, "keep.txt"), "")
		const open = sinon.spy(require("node:fs/promises"), "opendir")
		const files = await readDirectory(root, [["skip"], [".git"]])
		assert.deepEqual(files, [path.join(root, "keep.txt")])
		assert(!open.getCalls().some((call) => String(call.args[0]).endsWith("skip")))
	})
	it("does not descend into submodule Git links", async () => {
		await fs.mkdir(path.join(root, "submodule"))
		await fs.writeFile(path.join(root, "submodule", "file.ts"), "not part of the parent index")
		await git("git", [
			"-C",
			root,
			"update-index",
			"--add",
			"--cacheinfo",
			"160000,1111111111111111111111111111111111111111,submodule",
		])
		const files = []
		for await (const entry of walkWorkspace(root, {
			signal: AbortSignal.timeout(5_000),
			excludes: (entry) => entry.dirent.name === ".git",
		}))
			files.push(entry.relativePath)
		assert.deepEqual(files, ["submodule"])
	})
})
