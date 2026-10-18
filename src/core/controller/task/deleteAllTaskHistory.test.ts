import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { deleteAllTaskHistory } from "./deleteAllTaskHistory"

interface TaskHistoryEntry {
	id: string
	isFavorited?: boolean
	task?: string
}

describe("deleteAllTaskHistory", () => {
	let storagePath: string
	let showMessage: sinon.SinonStub
	let clearTask: sinon.SinonStub
	let replaceTaskHistory: sinon.SinonStub
	let postStateToWebview: sinon.SinonStub
	let taskHistory: TaskHistoryEntry[]

	beforeEach(async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-delete-history-"))
		showMessage = sinon.stub()
		clearTask = sinon.stub().resolves()
		replaceTaskHistory = sinon.stub()
		postStateToWebview = sinon.stub().resolves()
		taskHistory = []

		sinon.stub(HostProvider, "get").returns({
			globalStorageFsPath: storagePath,
			hostBridge: { windowClient: { showMessage } },
		} as any)
	})

	afterEach(async () => {
		sinon.restore()
		await fs.rm(storagePath, { recursive: true, force: true })
	})

	function controller() {
		return {
			clearTask,
			postStateToWebview,
			stateManager: {
				getGlobalStateKey: sinon
					.stub()
					.withArgs("taskHistory")
					.callsFake(() => taskHistory),
				removeTaskHistoryItems: replaceTaskHistory,
				flushPendingState: sinon.stub().resolves(),
			},
		} as any
	}

	async function createTaskFiles(...taskIds: string[]) {
		for (const taskId of taskIds) {
			const taskPath = path.join(storagePath, "tasks", taskId)
			await fs.mkdir(taskPath, { recursive: true })
			await fs.writeFile(path.join(taskPath, "task.json"), taskId)
		}
	}

	async function exists(filePath: string) {
		try {
			await fs.access(filePath)
			return true
		} catch {
			return false
		}
	}

	it("does not mutate anything when the first prompt is canceled", async () => {
		taskHistory = [{ id: "active-task" }]
		await createTaskFiles("active-task")
		showMessage.resolves({ selectedOption: undefined })

		const result = await deleteAllTaskHistory(controller())

		assert.equal(result.tasksDeleted, 0)
		sinon.assert.notCalled(clearTask)
		sinon.assert.notCalled(replaceTaskHistory)
		sinon.assert.notCalled(postStateToWebview)
		assert.equal(await exists(path.join(storagePath, "tasks", "active-task")), true)
	})

	it("does not mutate anything when the no-favorites warning is canceled", async () => {
		taskHistory = [{ id: "active-task", isFavorited: false }]
		await createTaskFiles("active-task")
		showMessage.onFirstCall().resolves({ selectedOption: "Delete All Except Favorites" })
		showMessage.onSecondCall().resolves({ selectedOption: undefined })

		const result = await deleteAllTaskHistory(controller())

		assert.equal(result.tasksDeleted, 0)
		sinon.assert.notCalled(clearTask)
		sinon.assert.notCalled(replaceTaskHistory)
		sinon.assert.notCalled(postStateToWebview)
		assert.equal(await exists(path.join(storagePath, "tasks", "active-task")), true)
	})

	it("does not delete all when refreshed history has no favorites without confirmation", async () => {
		taskHistory = [
			{ id: "favorite", isFavorited: true },
			{ id: "ordinary", isFavorited: false },
		]
		await createTaskFiles("favorite", "ordinary")
		showMessage.onFirstCall().resolves({ selectedOption: "Delete All Except Favorites" })
		showMessage.onSecondCall().resolves({ selectedOption: undefined })
		clearTask.callsFake(async () => {
			taskHistory = [{ id: "ordinary", isFavorited: false }]
		})

		const result = await deleteAllTaskHistory(controller())

		assert.equal(result.tasksDeleted, 0)
		sinon.assert.calledOnce(clearTask)
		sinon.assert.notCalled(replaceTaskHistory)
		sinon.assert.calledOnce(postStateToWebview)
		sinon.assert.calledTwice(showMessage)
		assert.equal(await exists(path.join(storagePath, "tasks", "favorite")), true)
		assert.equal(await exists(path.join(storagePath, "tasks", "ordinary")), true)
	})

	it("re-reads history after clearing and preserves the latest favorites", async () => {
		taskHistory = [
			{ id: "favorite", isFavorited: true, task: "old metadata" },
			{ id: "ordinary", isFavorited: false },
		]
		await createTaskFiles("favorite", "late-favorite", "ordinary")
		showMessage.resolves({ selectedOption: "Delete All Except Favorites" })
		clearTask.callsFake(async () => {
			taskHistory = [
				{ id: "favorite", isFavorited: true, task: "latest metadata" },
				{ id: "late-favorite", isFavorited: true },
				{ id: "ordinary", isFavorited: false },
			]
		})

		const result = await deleteAllTaskHistory(controller())

		assert.equal(result.tasksDeleted, 1)
		sinon.assert.calledOnce(clearTask)
		sinon.assert.calledOnceWithExactly(replaceTaskHistory, ["ordinary"])
		sinon.assert.calledOnce(postStateToWebview)
		assert.equal(await exists(path.join(storagePath, "tasks", "favorite")), true)
		assert.equal(await exists(path.join(storagePath, "tasks", "late-favorite")), true)
		assert.equal(await exists(path.join(storagePath, "tasks", "ordinary")), false)
	})

	it("deletes selected run directories without deleting shared storage roots", async () => {
		taskHistory = [
			{ id: "favorite", isFavorited: true },
			{ id: "ordinary", isFavorited: false },
		]
		await createTaskFiles("favorite", "ordinary")
		const checkpointPath = path.join(storagePath, "checkpoints", "ordinary")
		await fs.mkdir(checkpointPath, { recursive: true })
		await fs.writeFile(path.join(checkpointPath, "checkpoint.json"), "checkpoint")
		showMessage.resolves({ selectedOption: "Delete Everything" })

		const result = await deleteAllTaskHistory(controller())

		assert.equal(result.tasksDeleted, 2)
		sinon.assert.calledOnce(clearTask)
		sinon.assert.calledOnceWithExactly(replaceTaskHistory, ["favorite", "ordinary"])
		sinon.assert.calledOnce(postStateToWebview)
		assert.equal(await exists(path.join(storagePath, "tasks", "favorite")), false)
		assert.equal(await exists(path.join(storagePath, "tasks", "ordinary")), false)
		assert.equal(await exists(path.join(storagePath, "tasks")), true)
		assert.equal(await exists(path.join(storagePath, "checkpoints")), true)
	})
})
