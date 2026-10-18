import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import simpleGit from "simple-git"
import sinon from "sinon"
import { GitOperations } from "./CheckpointGitOperations"

describe("checkpoint staging with pruned nested Git discovery", function () {
	this.timeout(15_000)
	let temporary: string
	let workspace: string
	let shadow: string
	beforeEach(async () => {
		temporary = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-checkpoint-staging-"))
		workspace = path.join(temporary, "workspace")
		shadow = path.join(temporary, "shadow")
		await fs.mkdir(workspace)
		await fs.mkdir(shadow)
		await fs.mkdir(path.join(workspace, "nested"))
		await simpleGit(workspace).init()
		await simpleGit(path.join(workspace, "nested")).init()
		await fs.writeFile(path.join(workspace, "nested", "source.ts"), "initial\n")
	})
	afterEach(async () => {
		sinon.restore()
		await fs.rm(temporary, { recursive: true, force: true })
	})

	it("preserves nested file contents in the checkpoint and restores original Git metadata", async () => {
		const operations = new GitOperations(workspace)
		await operations.initShadowGit(path.join(shadow, ".git"), workspace, "test")
		const git = simpleGit(shadow)
		assert.equal(await git.show(["HEAD:nested/source.ts"]), "initial\n")
		assert((await fs.stat(path.join(workspace, ".git"))).isDirectory())
		assert((await fs.stat(path.join(workspace, "nested", ".git"))).isDirectory())
		await fs.writeFile(path.join(workspace, "nested", "source.ts"), "updated\n")
		assert.equal((await operations.addCheckpointFiles(git)).success, true)
		assert.equal(await git.show([":nested/source.ts"]), "updated\n")
		await assert.rejects(fs.stat(path.join(workspace, "nested", ".git_disabled")), { code: "ENOENT" })
	})

	it("stages nested contents hidden only by the workspace's info/exclude", async () => {
		await fs.writeFile(path.join(workspace, ".git", "info", "exclude"), "nested/\n")
		const operations = new GitOperations(workspace)
		await operations.initShadowGit(path.join(shadow, ".git"), workspace, "test")
		assert.equal(await simpleGit(shadow).show(["HEAD:nested/source.ts"]), "initial\n")
		assert((await fs.stat(path.join(workspace, "nested", ".git"))).isDirectory())
	})

	it("restores every rename when staging fails or discovery is cancelled", async () => {
		const operations = new GitOperations(workspace)
		await operations.initShadowGit(path.join(shadow, ".git"), workspace, "test")
		await fs.writeFile(path.join(workspace, "nested", "source.ts"), "changed\n")
		const git = simpleGit(shadow)
		sinon.stub(git, "add").rejects(new Error("injected staging failure"))
		assert.equal((await operations.addCheckpointFiles(git)).success, false)
		assert((await fs.stat(path.join(workspace, "nested", ".git"))).isDirectory())
		assert.equal((await operations.addCheckpointFiles(git, AbortSignal.abort(new Error("cancelled")))).success, false)
		assert((await fs.stat(path.join(workspace, "nested", ".git"))).isDirectory())
		assert.deepEqual(JSON.parse(await fs.readFile(path.join(shadow, "nested-git-recovery.json"), "utf8")), [])
	})
	it("rolls back a partially completed disable sequence", async () => {
		const operations = new GitOperations(workspace)
		await operations.initShadowGit(path.join(shadow, ".git"), workspace, "test")
		await fs.mkdir(path.join(workspace, "second"))
		await simpleGit(path.join(workspace, "second")).init()
		const filesystem = require("node:fs/promises") as typeof fs
		const rename = filesystem.rename
		let disables = 0
		sinon.stub(filesystem, "rename").callsFake(async (source, target) => {
			if (String(source).endsWith(`${path.sep}.git`) && ++disables === 2) throw new Error("injected rename failure")
			await rename(source, target)
		})
		assert.equal((await operations.addCheckpointFiles(simpleGit(shadow))).success, false)
		assert.equal(disables, 2)
		for (const nested of ["nested", "second"]) {
			assert((await fs.stat(path.join(workspace, nested, ".git"))).isDirectory())
			await assert.rejects(fs.stat(path.join(workspace, nested, ".git_disabled")), { code: "ENOENT" })
		}
	})
})
