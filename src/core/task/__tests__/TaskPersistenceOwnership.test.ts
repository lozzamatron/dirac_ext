import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { Task } from "../index"

function taskWithPersistenceOwner() {
	const task = Object.create(Task.prototype) as any
	task.messageStateHandler = {
		flushPendingWrites: sinon.stub().resolves(),
		retirePersistence: sinon.stub().resolves(),
	}
	task.releaseTaskLock = sinon.stub().resolves()
	task.lifecycleManager = { finalizeTaskRun: sinon.stub().resolves() }
	task.taskState = { settleRunOutcome: (outcome: unknown) => outcome }
	task.withStateLock = async (operation: () => unknown) => operation()
	return task
}

describe("Task persistence ownership", () => {
	it("flushes and retires the writer before releasing ownership exactly once", async () => {
		const task = taskWithPersistenceOwner()
		await Promise.all([task.retirePersistence(), task.retirePersistence()])
		sinon.assert.calledOnce(task.messageStateHandler.flushPendingWrites)
		sinon.assert.calledOnce(task.messageStateHandler.retirePersistence)
		sinon.assert.calledOnce(task.releaseTaskLock)
		sinon.assert.callOrder(
			task.messageStateHandler.flushPendingWrites,
			task.messageStateHandler.retirePersistence,
			task.releaseTaskLock,
		)
	})

	it("does not release ownership while writer retirement is still pending", async () => {
		const task = taskWithPersistenceOwner()
		let finishRetirement!: () => void
		task.messageStateHandler.retirePersistence.returns(
			new Promise<void>((resolve) => {
				finishRetirement = resolve
			}),
		)
		const retirement = task.retirePersistence()
		await Promise.resolve()
		sinon.assert.notCalled(task.releaseTaskLock)
		finishRetirement()
		await retirement
		sinon.assert.calledOnce(task.releaseTaskLock)
	})

	it("keeps completed and cancelled standalone tasks exclusively open for follow-up", async () => {
		for (const kind of ["completed", "cancelled"]) {
			const task = taskWithPersistenceOwner()
			task.executionProfile = "standalone"
			await task.settleTaskRun({ kind })
			sinon.assert.notCalled(task.releaseTaskLock)
			sinon.assert.notCalled(task.messageStateHandler.retirePersistence)
			await task.retirePersistence()
			sinon.assert.calledOnce(task.releaseTaskLock)
		}
	})

	it("retires Goal-owned task writers when their run finishes", async () => {
		const task = taskWithPersistenceOwner()
		task.executionProfile = "goal_child"
		await task.settleTaskRun({ kind: "completed", response: "done", completedAt: 1 })
		sinon.assert.callOrder(task.lifecycleManager.finalizeTaskRun, task.releaseTaskLock)
		sinon.assert.calledOnce(task.messageStateHandler.retirePersistence)
		sinon.assert.calledOnce(task.releaseTaskLock)
	})

	it("retires Goal-owned writers even if resource cleanup fails", async () => {
		const task = taskWithPersistenceOwner()
		task.executionProfile = "goal_child"
		task.lifecycleManager.finalizeTaskRun.rejects(new Error("cleanup failed"))
		const outcome = await task.settleTaskRun({ kind: "completed", response: "done", completedAt: 1 })
		assert.equal(outcome.kind, "failed")
		sinon.assert.calledOnce(task.releaseTaskLock)
	})
})
