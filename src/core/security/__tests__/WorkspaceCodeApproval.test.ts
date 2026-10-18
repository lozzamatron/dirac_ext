import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { approvedWorkspaceCode } from "../WorkspaceCodeApproval"

describe("workspace code grants", () => {
	let root: string
	let workspace: string
	let entry: string
	let selectedOption: string | undefined
	let trusted: boolean
	let prompts: number
	let restore: () => void

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-workspace-grant-"))
		workspace = path.join(root, "checkout")
		await fs.mkdir(workspace)
		entry = path.join(workspace, "TaskStart")
		await fs.writeFile(entry, "approved")
		selectedOption = undefined
		trusted = true
		prompts = 0
		const stub = sinon.stub(HostProvider, "get").returns({
			globalStorageFsPath: root,
			diracType: "extension",
			isWorkspaceTrusted: () => trusted,
			hostBridge: {
				windowClient: {
					showMessage: async () => {
						prompts++
						return { selectedOption }
					},
				},
			},
		} as any)
		restore = () => stub.restore()
	})

	afterEach(async () => {
		restore()
		await fs.rm(root, { recursive: true, force: true })
	})

	it("requires a human decision and remembers only approved bytes", async () => {
		assert.equal(await approvedWorkspaceCode(workspace, entry, undefined, true), undefined)
		assert.equal(prompts, 1)
		selectedOption = "Trust and run this code"
		const approved = await approvedWorkspaceCode(workspace, entry, undefined, true)
		assert.equal(approved?.source.toString(), "approved")
		assert.equal(prompts, 2)
		assert.ok(await approvedWorkspaceCode(workspace, entry))
		assert.equal(prompts, 2)
		await fs.writeFile(entry, "changed")
		assert.equal(await approvedWorkspaceCode(workspace, entry), undefined)
	})

	it("rejects symlink retargeting, workspace escapes, and restricted mode", async () => {
		selectedOption = "Trust and run this code"
		await approvedWorkspaceCode(workspace, entry, undefined, true)
		const replacement = path.join(workspace, "replacement")
		await fs.writeFile(replacement, "approved")
		await fs.unlink(entry)
		await fs.symlink(replacement, entry)
		assert.equal(await approvedWorkspaceCode(workspace, entry), undefined)
		await assert.rejects(() => approvedWorkspaceCode(workspace, root), /escapes its root/)
		trusted = false
		assert.equal(await approvedWorkspaceCode(workspace, entry, undefined, true), undefined)
	})

	it("revokes grants when the manifest changes without changing the source", async () => {
		const manifest = path.join(workspace, "dirac-tool.json")
		await fs.writeFile(manifest, '{"id":"tool"}')
		selectedOption = "Trust and run this code"
		await approvedWorkspaceCode(workspace, entry, manifest, true)
		await fs.writeFile(manifest, '{"id":"other"}')
		assert.equal(await approvedWorkspaceCode(workspace, entry, manifest), undefined)
	})
})
