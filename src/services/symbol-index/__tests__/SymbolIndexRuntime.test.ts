import { EventEmitter } from "node:events"
import type { FSWatcher } from "node:fs"
import { afterEach, describe, it } from "mocha"
import "should"
import sinon from "sinon"
import { Logger } from "@/shared/services/Logger"
import { SymbolIndexRuntime, type SymbolIndexRuntimeDependencies, type SymbolIndexWatchFactory } from "../SymbolIndexRuntime"

interface WatchRecord {
	watchPath: string
	options: { persistent: boolean; recursive: boolean }
	listener: (eventType: "rename" | "change", filename: string | Buffer | null) => void
	watcher: FSWatcher
	close: sinon.SinonStub
}

describe("SymbolIndexRuntime", () => {
	let runtime: SymbolIndexRuntime | null = null
	let clock: sinon.SinonFakeTimers | null = null
	let watchRecords: WatchRecord[] = []

	afterEach(async () => {
		await runtime?.dispose()
		clock?.restore()
		runtime = null
		clock = null
		watchRecords = []
		sinon.restore()
	})

	it("starts with one non-recursive root watcher", () => {
		runtime = createRuntime()

		watchRecords.length.should.equal(1)
		watchRecords[0].watchPath.should.equal("/workspace")
		watchRecords[0].options.should.deepEqual({ persistent: true, recursive: false })
	})

	it("batches supported watcher mutations into one callback", async () => {
		clock = sinon.useFakeTimers()
		const applyWatcherEvents = sinon.stub().resolves()
		runtime = createRuntime({ applyWatcherEvents })

		;(runtime as any).queueFileEvent("/workspace/src/a.ts", "change")
		;(runtime as any).queueFileEvent("/workspace/src/a.ts", "change")
		;(runtime as any).queueFileEvent("/workspace/src/b.ts", "remove")
		await clock.tickAsync(1_000)

		sinon.assert.calledOnce(applyWatcherEvents)
		applyWatcherEvents.firstCall.args[0].should.deepEqual([
			{ absolutePath: "/workspace/src/a.ts", kind: "change" },
			{ absolutePath: "/workspace/src/b.ts", kind: "remove" },
		])
	})

	it("requests reconciliation when pending watcher events overflow", () => {
		clock = sinon.useFakeTimers()
		const requestReconciliation = sinon.stub().resolves()
		runtime = createRuntime({ requestReconciliation })

		for (let index = 0; index <= 500; index++) {
			;(runtime as any).queueFileEvent(`/workspace/src/${index}.ts`, "change")
		}

		sinon.assert.calledOnceWithExactly(requestReconciliation, "watcher event overflow")
	})

	it("degrades to reconciliation-only mode when the workspace watcher reports EMFILE", () => {
		const requestReconciliation = sinon.stub().resolves()
		runtime = createRuntime({ requestReconciliation })
		const error = Object.assign(new Error("injected watcher failure"), { code: "EMFILE" })

		watchRecords[0].watcher.emit("error", error)

		watchRecords[0].close.calledOnce.should.be.true()
		requestReconciliation.calledOnce.should.be.true()
		requestReconciliation.firstCall.args[0].should.match(/capacity exhausted/)
		;(runtime as any).liveWatchingDisabled.should.be.true()
	})

	it("requests reconciliation when the native watcher omits the changed filename", () => {
		const requestReconciliation = sinon.stub().resolves()
		runtime = createRuntime({ requestReconciliation })

		watchRecords[0].listener("rename", null)

		sinon.assert.calledOnceWithExactly(requestReconciliation, "workspace watcher reported an ambiguous path")
	})

	it("treats nested ignore and Git control changes as reconciliation requests before exclusion", () => {
		const requestReconciliation = sinon.stub().resolves()
		const isControlPath = sinon
			.stub()
			.callsFake((absolutePath: string) => absolutePath.endsWith(".gitignore") || absolutePath.endsWith("/.git/index"))
		runtime = createRuntime({ requestReconciliation, isControlPath, excludesPath: () => true })

		watchRecords[0].listener("change", "src/.gitignore")
		watchRecords[0].listener("change", ".git/index")

		requestReconciliation.callCount.should.equal(2)
	})

	it("groups external controls by parent directory instead of watching each file", () => {
		runtime = createRuntime()

		runtime.refreshExternalControlPaths(
			new Set(["/external/git/config", "/external/git/global-ignore", "/external/dirac/include"]),
		)

		watchRecords.length.should.equal(3)
		watchRecords
			.slice(1)
			.map((record) => record.watchPath)
			.sort()
			.should.deepEqual(["/external/dirac", "/external/git"])
		watchRecords
			.slice(1)
			.every((record) => record.options.recursive === false)
			.should.be.true()
	})

	it("retries an external control watcher after a transient startup failure", async () => {
		clock = sinon.useFakeTimers()
		let externalFailuresRemaining = 1
		const watchFactory: SymbolIndexWatchFactory = (watchPath, options, listener) => {
			if (watchPath === "/external/git" && externalFailuresRemaining-- > 0) {
				throw Object.assign(new Error("injected watcher failure"), { code: "ENOENT" })
			}
			return recordWatch(watchPath, options, listener)
		}
		runtime = createRuntime({}, watchFactory)

		runtime.refreshExternalControlPaths(new Set(["/external/git/global-ignore"]))
		watchRecords.length.should.equal(1)

		await clock.tickAsync(1_000)
		watchRecords.length.should.equal(2)
		watchRecords[1].watchPath.should.equal("/external/git")
	})

	it("backs off repeated asynchronous external watcher failures", async () => {
		clock = sinon.useFakeTimers()
		runtime = createRuntime()
		runtime.refreshExternalControlPaths(new Set(["/external/git/global-ignore"]))

		watchRecords[1].watcher.emit("error", Object.assign(new Error("failure 1"), { code: "ENOENT" }))
		await clock.tickAsync(1_000)
		watchRecords.length.should.equal(3)

		watchRecords[2].watcher.emit("error", Object.assign(new Error("failure 2"), { code: "ENOENT" }))
		await clock.tickAsync(1_999)
		watchRecords.length.should.equal(3)
		await clock.tickAsync(1)
		watchRecords.length.should.equal(4)
	})

	it("resets external watcher backoff after a stable retry", async () => {
		clock = sinon.useFakeTimers()
		runtime = createRuntime()
		runtime.refreshExternalControlPaths(new Set(["/external/git/global-ignore"]))

		watchRecords[1].watcher.emit("error", Object.assign(new Error("initial failure"), { code: "ENOENT" }))
		await clock.tickAsync(1_000)
		await clock.tickAsync(30_000)
		watchRecords[2].watcher.emit("error", Object.assign(new Error("later failure"), { code: "ENOENT" }))

		await clock.tickAsync(999)
		watchRecords.length.should.equal(3)
		await clock.tickAsync(1)
		watchRecords.length.should.equal(4)
	})

	it("drains events queued while a watcher batch is active without overlapping callbacks", async () => {
		clock = sinon.useFakeTimers()
		let releaseFirst!: () => void
		const firstBatchBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const applyWatcherEvents = sinon.stub()
		applyWatcherEvents.onFirstCall().returns(firstBatchBlocked)
		applyWatcherEvents.onSecondCall().resolves()
		runtime = createRuntime({ applyWatcherEvents })

		;(runtime as any).queueFileEvent("/workspace/src/a.ts", "change")
		await clock.tickAsync(1_000)
		;(runtime as any).queueFileEvent("/workspace/src/b.ts", "change")
		await clock.tickAsync(1_000)
		applyWatcherEvents.callCount.should.equal(1)

		releaseFirst()
		await (runtime as any).activeFlush
		applyWatcherEvents.callCount.should.equal(2)
		applyWatcherEvents.secondCall.args[0].should.deepEqual([{ absolutePath: "/workspace/src/b.ts", kind: "change" }])
	})

	it("logs rejected reconciliation requests instead of leaking unhandled rejections", async () => {
		const requestReconciliation = sinon.stub().rejects(new Error("injected reconciliation failure"))
		const error = sinon.stub(Logger, "error")
		runtime = createRuntime({ requestReconciliation })

		;(runtime as any).requestFullReconciliation("test failure")
		await new Promise((resolve) => setImmediate(resolve))

		error.calledOnce.should.be.true()
		error.firstCall.args[0].should.match(/test failure/)
	})

	it("runs periodic repair after live watching is disabled and disposes the timer", async () => {
		clock = sinon.useFakeTimers()
		sinon.stub(Math, "random").returns(0.5)
		const requestReconciliation = sinon.stub().resolves()
		runtime = createRuntime({ requestReconciliation })
		watchRecords[0].watcher.emit("error", Object.assign(new Error("capacity"), { code: "EMFILE" }))
		requestReconciliation.resetHistory()
		;(runtime as any).reconciliationTimer.hasRef().should.be.false()

		await clock.tickAsync(5 * 60_000)
		sinon.assert.calledOnceWithExactly(requestReconciliation, "periodic repair")
		await runtime.dispose()
		runtime = null
		await clock.tickAsync(10 * 60_000)
		requestReconciliation.callCount.should.equal(1)
	})

	function recordWatch(
		watchPath: string,
		options: { persistent: boolean; recursive: boolean },
		listener: (eventType: "rename" | "change", filename: string | Buffer | null) => void,
	): FSWatcher {
		const watcher = new EventEmitter() as FSWatcher
		const close = sinon.stub()
		watcher.close = close
		watcher.ref = sinon.stub().returns(watcher)
		watcher.unref = sinon.stub().returns(watcher)
		watchRecords.push({ watchPath, options, listener, watcher, close })
		return watcher
	}

	function createRuntime(
		overrides: Partial<SymbolIndexRuntimeDependencies> = {},
		watchFactory: SymbolIndexWatchFactory = recordWatch,
	): SymbolIndexRuntime {
		return new SymbolIndexRuntime(
			"/workspace",
			{
				admitsPath: () => true,
				excludesPath: () => false,
				isControlPath: () => false,
				applyWatcherEvents: async () => {},
				requestReconciliation: async () => {},
				...overrides,
			},
			watchFactory,
		)
	}
})
