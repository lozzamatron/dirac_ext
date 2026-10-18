import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { SymbolIndexService } from "../SymbolIndexService"
import { SymbolIndexEligibility } from "../SymbolIndexEligibility"

const git = promisify(execFile)
async function eventually(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 8_000
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Live index did not converge within 8 seconds")
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
}

describe("symbol index real filesystem watches", function () {
	this.timeout(30_000)
	let root: string
	let service: SymbolIndexService
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-live-index-"))
		await git("git", ["init", "-q", root])
		service = SymbolIndexService.getInstance()
		service.setPersistenceEnabled(false)
	})
	afterEach(async () => {
		service.dispose()
		sinon.restore()
		await fs.rm(root, { recursive: true, force: true })
	})

	it("keeps coverage and freshness while excluding ignored watch trees", async () => {
		await fs.mkdir(path.join(root, "src"))
		await fs.mkdir(path.join(root, "empty"))
		await fs.mkdir(path.join(root, "ascratch", "deep"), { recursive: true })
		await fs.writeFile(path.join(root, ".gitignore"), "ascratch/\n")
		await fs.writeFile(path.join(root, "src", "main.ts"), "export function original() {}\noriginal()\n")
		await fs.writeFile(path.join(root, "ascratch", "deep", "ignored.ts"), "export function hidden() {}\n")
		await service.initialize(root)
		assert.equal(service.getDefinitions("original").length, 1)
		assert(service.getReferences("original").length > 0)
		assert.equal(service.getDefinitions("hidden").length, 0)
		const runtime = Reflect.get(service, "runtime")
		const watched: Map<string, unknown> = Reflect.get(runtime, "workspaceWatchers")
		assert.deepEqual([...watched.keys()].sort(), [root, path.join(root, "empty"), path.join(root, "src")].sort())

		await fs.writeFile(path.join(root, "empty", "new.ts"), "export function inEmpty() {}\n")
		await eventually(() => service.getDefinitions("inEmpty").length === 1)
		await fs.mkdir(path.join(root, "newdir"))
		await fs.writeFile(path.join(root, "newdir", "new.ts"), "export function inNewDir() {}\n")
		await eventually(() => service.getDefinitions("inNewDir").length === 1)
		await fs.writeFile(path.join(root, "src", "main.ts"), "export function editedLongerName() {}\n")
		await eventually(() => service.getDefinitions("editedLongerName").length === 1)
		assert.equal(service.getDefinitions("original").length, 0)

		await fs.writeFile(path.join(root, ".gitignore"), "ascratch/\nnewdir/\n")
		await eventually(() => service.getDefinitions("inNewDir").length === 0 && !watched.has(path.join(root, "newdir")))
		await fs.writeFile(path.join(root, ".gitignore"), "newdir/\n")
		await eventually(() => service.getDefinitions("hidden").length === 1 && watched.has(path.join(root, "ascratch", "deep")))
		await fs.rename(path.join(root, "empty", "new.ts"), path.join(root, "empty", "renamed.ts"))
		await eventually(() => service.getDefinitions("inEmpty").some((symbol) => symbol.path.endsWith("renamed.ts")))
		await fs.rm(path.join(root, "empty", "renamed.ts"))
		await eventually(() => service.getDefinitions("inEmpty").length === 0)
		service.dispose()
		assert.equal(watched.size, 0)
	})

	it("retains valid indexed definitions when directory enumeration fails", async () => {
		await fs.writeFile(path.join(root, "main.ts"), "export function retained() {}\n")
		await service.initialize(root)
		const failure = sinon.stub(SymbolIndexEligibility.prototype, "enumerate").rejects(new Error("injected discovery failure"))
		const { Logger } = await import("@/shared/services/Logger")
		const logged = sinon.stub(Logger, "error")
		await service.requestReconciliation("failure test")
		assert(logged.calledOnce)
		assert.match(String(logged.firstCall.args[1]), /injected discovery failure/)
		assert.equal(service.getDefinitions("retained").length, 1)
		failure.restore()
	})
})
