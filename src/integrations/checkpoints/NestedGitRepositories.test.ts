import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, it } from "mocha"
import { NestedGitRepositories } from "./NestedGitRepositories"

const git = promisify(execFile)

describe("nested Git checkpoint recovery", () => {
	let root: string
	let journal: string
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-nested-git-"))
		journal = path.join(root, ".git", "dirac-recovery.json")
		await git("git", ["init", "-q", root])
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	it("prunes checkpoint exclusions and restores recorded paths even after they become Git-ignored", async () => {
		await git("git", ["init", "-q", path.join(root, "included")])
		await git("git", ["init", "-q", path.join(root, "ignored")])
		await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n")
		const repositories = new NestedGitRepositories(root, journal, ["ignored/"])
		await repositories.recover(AbortSignal.timeout(5_000))
		await repositories.disable(AbortSignal.timeout(5_000))
		assert((await fs.stat(path.join(root, "included", ".git_disabled"))).isDirectory())
		assert((await fs.stat(path.join(root, "ignored", ".git"))).isDirectory())
		await fs.writeFile(path.join(root, ".gitignore"), "ignored/\nincluded/\n")
		await repositories.restore()
		assert((await fs.stat(path.join(root, "included", ".git"))).isDirectory())
		assert.deepEqual(JSON.parse(await fs.readFile(journal, "utf8")), [])
	})

	it("recovers legacy disabled repositories inside ignored trees before creating its journal", async () => {
		await fs.mkdir(path.join(root, "ignored", ".git_disabled"), { recursive: true })
		await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n")
		await new NestedGitRepositories(root, journal).recover(AbortSignal.timeout(5_000))
		assert((await fs.stat(path.join(root, "ignored", ".git"))).isDirectory())
	})

	it("cancellation before mutation cannot strand nested repositories", async () => {
		await git("git", ["init", "-q", path.join(root, "nested")])
		const repositories = new NestedGitRepositories(root, journal)
		await repositories.recover(AbortSignal.timeout(5_000))
		await assert.rejects(repositories.disable(AbortSignal.abort(new Error("stop"))), /stop/)
		await repositories.restore()
		assert((await fs.stat(path.join(root, "nested", ".git"))).isDirectory())
	})
	it("recovers from a durable journal without scanning newly ignored trees", async () => {
		await fs.mkdir(path.join(root, "ignored", ".git_disabled"), { recursive: true })
		await fs.writeFile(path.join(root, ".gitignore"), "ignored/\n")
		await fs.writeFile(journal, JSON.stringify(["ignored/.git"]))
		await new NestedGitRepositories(root, journal).recover(AbortSignal.timeout(5_000))
		assert((await fs.stat(path.join(root, "ignored", ".git"))).isDirectory())
	})

	it("cancels a recovery waiter without letting later recovery overtake the active transaction", async () => {
		await git("git", ["init", "-q", path.join(root, "nested")])
		const first = new NestedGitRepositories(root, journal)
		const second = new NestedGitRepositories(root, journal)
		await first.recover(AbortSignal.timeout(5_000))
		await first.disable(AbortSignal.timeout(5_000))
		const controller = new AbortController()
		const cancelled = new NestedGitRepositories(root, journal).recover(controller.signal)
		const cancellation = assert.rejects(cancelled, /stop waiting/)
		let recovered = false
		const recovery = second.recover(AbortSignal.timeout(5_000)).then(() => {
			recovered = true
		})
		controller.abort(new Error("stop waiting"))
		await cancellation
		await new Promise((resolve) => setTimeout(resolve, 20))
		assert.equal(recovered, false)
		await first.restore()
		await recovery
		assert((await fs.stat(path.join(root, "nested", ".git"))).isDirectory())
	})
})
