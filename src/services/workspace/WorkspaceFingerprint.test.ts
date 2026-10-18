import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { fingerprintWorkspaceRoots } from "./WorkspaceFingerprint"

describe("fingerprintWorkspaceRoots", () => {
	let workspace: string

	beforeEach(async () => {
		workspace = await mkdtemp(path.join(os.tmpdir(), "dirac-workspace-fingerprint-"))
	})

	afterEach(async () => {
		await rm(workspace, { recursive: true, force: true })
	})

	it("ignores timestamps and unchanged rewrites but detects content changes", async () => {
		const artifact = path.join(workspace, "artifact.txt")
		await writeFile(artifact, "first", "utf8")
		const initial = await fingerprintWorkspaceRoots([workspace])

		await writeFile(artifact, "first", "utf8")
		await utimes(artifact, new Date(), new Date(Date.now() + 10_000))
		assert.equal(await fingerprintWorkspaceRoots([workspace]), initial)

		await writeFile(artifact, "second", "utf8")
		assert.notEqual(await fingerprintWorkspaceRoots([workspace]), initial)
	})

	it("detects file creation and deletion", async () => {
		const initial = await fingerprintWorkspaceRoots([workspace])
		const artifact = path.join(workspace, "created.bin")
		await writeFile(artifact, Buffer.from([0, 1, 2, 3]))
		const created = await fingerprintWorkspaceRoots([workspace])
		assert.notEqual(created, initial)

		await rm(artifact)
		assert.equal(await fingerprintWorkspaceRoots([workspace]), initial)
	})

	it("excludes dependency and VCS metadata", async () => {
		const initial = await fingerprintWorkspaceRoots([workspace])
		await mkdir(path.join(workspace, ".git"), { recursive: true })
		await mkdir(path.join(workspace, "node_modules", "package"), { recursive: true })
		await writeFile(path.join(workspace, ".git", "index"), "changed", "utf8")
		await writeFile(path.join(workspace, "node_modules", "package", "index.js"), "changed", "utf8")

		assert.equal(await fingerprintWorkspaceRoots([workspace]), initial)
	})
	it("preserves sensitivity to Git-ignored deliverables but excludes Dirac's own index cache", async () => {
		await writeFile(path.join(workspace, ".gitignore"), "dist/\n")
		await mkdir(path.join(workspace, "dist"))
		await writeFile(path.join(workspace, "dist", "artifact.txt"), "first")
		const initial = await fingerprintWorkspaceRoots([workspace])
		await mkdir(path.join(workspace, ".dirac-cache"))
		await writeFile(path.join(workspace, ".dirac-cache", "symbol-index.db"), "internal")
		assert.equal(await fingerprintWorkspaceRoots([workspace]), initial)
		await writeFile(path.join(workspace, "dist", "artifact.txt"), "other")
		assert.notEqual(await fingerprintWorkspaceRoots([workspace]), initial)
	})

	it("rejects cancellation and exhausted budgets instead of accepting a partial fingerprint", async () => {
		await writeFile(path.join(workspace, "artifact.txt"), "content")
		await assert.rejects(fingerprintWorkspaceRoots([workspace], { maxBytes: 1 }), /byte budget/)
		await assert.rejects(fingerprintWorkspaceRoots([workspace], { maxEntries: 0 }), /entry budget/)
		await assert.rejects(
			fingerprintWorkspaceRoots([workspace], { signal: AbortSignal.abort(new Error("cancelled")) }),
			/cancelled/,
		)
	})
})
