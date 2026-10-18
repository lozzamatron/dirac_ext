import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { TaskStatus } from "@shared/ExtensionMessage"
import { TaskState } from "../TaskState"
import { SteeringDeliveryState } from "../steering"

describe("TaskState", () => {
	it("initializes with sane defaults", () => {
		const state = new TaskState()
		assert.equal(state.status, TaskStatus.IDLE)
		assert.equal(state.isInitialized, false)
		assert.equal(state.isApiRequestActive, false)
		assert.equal(state.didCompleteReadingStream, false)
		assert.equal(state.abandoned, false)
		assert.equal(state.totalToolCallCount, 0)
		assert.equal(state.consecutiveMistakeCount, 0)
		assert.equal(state.apiErrorRetryAttempts, 0)
		assert.equal(state.emptyResponseRetryAttempts, 0)
		assert.equal(state.totalCost, 0)
		assert.equal(state.utilityPermissionInputTokens, 0)
		assert.equal(state.utilityPermissionOutputTokens, 0)
		assert.equal(state.utilityPermissionCacheWriteTokens, 0)
		assert.equal(state.utilityPermissionCacheReadTokens, 0)
		assert.equal(state.utilityPermissionCost, 0)
		assert.equal(state.totalInputTokens, 0)
		assert.equal(state.totalOutputTokens, 0)
		assert.equal(state.totalCacheWriteTokens, 0)
		assert.equal(state.totalCacheReadTokens, 0)
		assert.deepEqual(state.waitingCardIds, [])
		assert.deepEqual(state.toolUseIdMap, new Map())
		assert.deepEqual(state.steeringMessages, [])
		assert.deepEqual(state.availableSkills, [])
		assert.deepEqual(state.activeSkillIds, [])
		assert.equal(state.abort, false)
		assert.ok(Number.isFinite(state.taskStartTimeMs))
	})

	it("exposes the first waiting card id FIFO", () => {
		const state = new TaskState()
		assert.equal(state.lastWaitingCardId, undefined)
		state.waitingCardIds.push("card-1", "card-2")
		assert.equal(state.lastWaitingCardId, "card-1")
		state.waitingCardIds.unshift("card-0")
		assert.equal(state.lastWaitingCardId, "card-0")
		state.waitingCardIds.shift()
		assert.equal(state.lastWaitingCardId, "card-1")
	})

	it("aborts the current signal and creates a fresh signal when reset", () => {
		const state = new TaskState()
		const initialSignal = state.abortSignal

		assert.equal(state.abort, false)
		assert.equal(initialSignal.aborted, false)

		state.abort = true

		assert.equal(state.abort, true)
		assert.equal(initialSignal.aborted, true)

		state.abort = false

		assert.equal(state.abort, false)
		assert.notEqual(state.abortSignal, initialSignal)
		assert.equal(state.abortSignal.aborted, false)
	})

	it("is idempotent when aborting an already-aborted controller", () => {
		const state = new TaskState()
		const signal = state.abortSignal
		state.abort = true
		state.abort = true // second abort must not swap the signal
		assert.equal(state.abortSignal, signal)
		assert.equal(state.abortSignal.aborted, true)
	})

	it("tracks tool execution and retry flags independently", () => {
		const state = new TaskState()
		state.didRejectTool = true
		state.didAlreadyUseTool = true
		state.didEditFile = true
		state.consecutiveMistakeCount = 3
		state.apiErrorRetryAttempts += 1
		state.emptyResponseRetryAttempts += 2

		assert.equal(state.didRejectTool, true)
		assert.equal(state.didAlreadyUseTool, true)
		assert.equal(state.didEditFile, true)
		assert.equal(state.consecutiveMistakeCount, 3)
		assert.equal(state.apiErrorRetryAttempts, 1)
		assert.equal(state.emptyResponseRetryAttempts, 2)
	})

	it("maps tool names to ids and accumulates metrics", () => {
		const state = new TaskState()
		state.toolUseIdMap.set("read_file", "toolu_1")
		state.totalInputTokens += 100
		state.totalOutputTokens += 50
		state.totalCost += 1.25
		state.totalToolCallCount += 1

		assert.equal(state.toolUseIdMap.get("read_file"), "toolu_1")
		assert.equal(state.totalInputTokens, 100)
		assert.equal(state.totalOutputTokens, 50)
		assert.equal(state.totalCost, 1.25)
		assert.equal(state.totalToolCallCount, 1)
	})

	it("records a pending task replacement", () => {
		const state = new TaskState()
		state.pendingTaskReplacement = { context: "do the next thing" }
		assert.deepEqual(state.pendingTaskReplacement, { context: "do the next thing" })
		state.pendingTaskReplacement = undefined
		assert.equal(state.pendingTaskReplacement, undefined)
	})

	it("accumulates steering messages", () => {
		const state = new TaskState()
		state.steeringMessages.push({
			id: "s1",
			text: "steer",
			createdAt: 1,
			transcriptMessageId: "m1",
			deliveryState: SteeringDeliveryState.QUEUED,
		})
		assert.equal(state.steeringMessages.length, 1)
		assert.equal(state.steeringMessages[0].text, "steer")
	})
})
