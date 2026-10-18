import { CardStatus, DiracMessageType, TaskStatus } from "@shared/ExtensionMessage";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	stateSubscriber: undefined as undefined | ((update: { stateJson: string; presentationJson?: string }) => Promise<void>),
	cancelRequest: vi.fn(),
	showTaskWithId: vi.fn(),
}))

vi.mock("@/core/controller/state/subscribeToState", () => ({
	subscribeToState: vi.fn(async (_controller, _request, subscriber) => {
		mocks.stateSubscriber = subscriber
	}),
}))

vi.mock("@/core/controller/grpc-handler", () => ({
	getRequestRegistry: () => ({ cancelRequest: mocks.cancelRequest }),
}))

vi.mock("@/core/controller/task/showTaskWithId", () => ({
	showTaskWithId: mocks.showTaskWithId,
}))

vi.mock("./task-start-output", () => ({
	emitTaskStartedMessage: vi.fn(),
}))

import { runPlainTextTask } from "./plain-text-task";

function stateJson(taskStatus: TaskStatus): string {
	return JSON.stringify({
		taskStatus,
		diracMessages: [],
		uiActionState: { globalButtons: [], cardButtons: [] },
	})
}

describe("runPlainTextTask", () => {
	beforeEach(() => {
		mocks.stateSubscriber = undefined
		mocks.cancelRequest.mockReset()
		mocks.showTaskWithId.mockReset()
	})

	it("waits for the new turn when resuming a completed task with a follow-up", async () => {
		const submitCardResponse = vi.fn().mockResolvedValue(undefined)
		const controller = {
			task: {
				taskId: "task-1",
				submitCardResponse,
				abortTask: vi.fn(),
				messageStateHandler: { getDiracMessages: () => [] },
			},
		}
		mocks.showTaskWithId.mockImplementation(async () => {
			await mocks.stateSubscriber?.({ stateJson: stateJson(TaskStatus.COMPLETED) })
		})

		let settled = false
		const resultPromise = runPlainTextTask({
			controller: controller as never,
			taskId: "task-1",
			prompt: "follow up",
		}).finally(() => {
			settled = true
		})

		await vi.waitFor(() => expect(submitCardResponse).toHaveBeenCalledOnce())
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(settled).toBe(false)

		await mocks.stateSubscriber?.({ stateJson: stateJson(TaskStatus.COMPLETED) })
		await expect(resultPromise).resolves.toBe(true)
	})

	it("ignores the restored terminal snapshot delivered after a follow-up is submitted", async () => {
		const submitCardResponse = vi.fn().mockResolvedValue(undefined)
		const controller = {
			task: {
				taskId: "task-1",
				submitCardResponse,
				abortTask: vi.fn(),
				taskState: { status: TaskStatus.COMPLETED },
				messageStateHandler: { getDiracMessages: () => [] },
			},
		}
		mocks.showTaskWithId.mockResolvedValue(undefined)

		let settled = false
		const resultPromise = runPlainTextTask({
			controller: controller as never,
			taskId: "task-1",
			prompt: "follow up",
		}).finally(() => {
			settled = true
		})

		await vi.waitFor(() => expect(submitCardResponse).toHaveBeenCalledOnce())

		// Delayed replay of the restored terminal status — must not settle.
		await mocks.stateSubscriber?.({ stateJson: stateJson(TaskStatus.COMPLETED) })
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(settled).toBe(false)

		// The follow-up turn's first divergent status opens the latch.
		await mocks.stateSubscriber?.({ stateJson: stateJson(TaskStatus.WAITING_FOR_API) })
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(settled).toBe(false)

		// The new turn's real completion resolves.
		await mocks.stateSubscriber?.({ stateJson: stateJson(TaskStatus.COMPLETED) })
		await expect(resultPromise).resolves.toBe(true)
	})

	it("ignores replayed failures from before a follow-up, even with a current timestamp", async () => {
		const oldApiFailure = {
			id: "old-api-failure",
			ts: Date.now() + 10_000,
			content: { type: DiracMessageType.API_STATUS, status: { cancelReason: "retries_exhausted" } },
		}
		const oldTaskFailure = {
			id: "old-task-failure",
			ts: Date.now() + 10_000,
			content: {
				type: DiracMessageType.CARD,
				card: { id: "old-task-failure", header: "Task Failed", status: CardStatus.ERROR, body: "Old mistake" },
			},
		}
		const submitCardResponse = vi.fn().mockResolvedValue(undefined)
		const controller = {
			task: {
				taskId: "task-1",
				submitCardResponse,
				abortTask: vi.fn(),
				taskState: { status: TaskStatus.CANCELLED },
				messageStateHandler: { getDiracMessages: () => [oldApiFailure, oldTaskFailure] },
			},
		}
		mocks.showTaskWithId.mockResolvedValue(undefined)

		let settled = false
		const resultPromise = runPlainTextTask({
			controller: controller as never,
			taskId: "task-1",
			prompt: "again",
		}).finally(() => {
			settled = true
		})
		await vi.waitFor(() => expect(submitCardResponse).toHaveBeenCalledOnce())
		await mocks.stateSubscriber?.({
			stateJson: JSON.stringify({ taskStatus: TaskStatus.CANCELLED, diracMessages: [oldApiFailure, oldTaskFailure] }),
		})
		await mocks.stateSubscriber?.({ stateJson: stateJson(TaskStatus.WAITING_FOR_API) })
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(settled).toBe(false)
		await mocks.stateSubscriber?.({ stateJson: stateJson(TaskStatus.COMPLETED) })
		await expect(resultPromise).resolves.toBe(true)
	})

	it("still rejects when a turn resumed from CANCELLED is cancelled again", async () => {
		const submitCardResponse = vi.fn().mockResolvedValue(undefined)
		const controller = {
			task: {
				taskId: "task-1",
				submitCardResponse,
				abortTask: vi.fn(),
				taskState: { status: TaskStatus.CANCELLED },
				messageStateHandler: { getDiracMessages: () => [] },
			},
		}
		mocks.showTaskWithId.mockResolvedValue(undefined)

		let settled = false
		const resultPromise = runPlainTextTask({
			controller: controller as never,
			taskId: "task-1",
			prompt: "follow up",
		}).finally(() => {
			settled = true
		})
		await vi.waitFor(() => expect(submitCardResponse).toHaveBeenCalledOnce())

		// Replayed CANCELLED is suppressed — nothing settles yet.
		await mocks.stateSubscriber?.({ stateJson: stateJson(TaskStatus.CANCELLED) })
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(settled).toBe(false)

		// Live turn diverges, then is cancelled — a real failure this time.
		await mocks.stateSubscriber?.({ stateJson: stateJson(TaskStatus.PREPARING) })
		await mocks.stateSubscriber?.({ stateJson: stateJson(TaskStatus.CANCELLED) })
		await expect(resultPromise).resolves.toBe(false)
	})

	it("emits the initial streaming API status as JSON in JSON mode", async () => {
		const apiMessage = {
			id: "api-1",
			ts: 1,
			content: { type: DiracMessageType.API_STATUS, status: { id: "request-1" } },
		}
		const controller = {
			task: {
				taskId: "task-1",
				abortTask: vi.fn(),
				messageStateHandler: { getDiracMessages: () => [] },
			},
			initTask: vi.fn(async () => {
				await mocks.stateSubscriber?.({
					stateJson: JSON.stringify({
						taskStatus: TaskStatus.WAITING_FOR_API,
						diracMessages: [apiMessage],
						isApiRequestActive: true,
						uiActionState: { globalButtons: [], cardButtons: [] },
					}),
				})
				await mocks.stateSubscriber?.({ stateJson: stateJson(TaskStatus.COMPLETED) })
			}),
		}
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

		await expect(runPlainTextTask({ controller: controller as never, prompt: "do it", jsonOutput: true })).resolves.toBe(true)

		expect(stdout).toHaveBeenCalledWith(`${JSON.stringify(apiMessage)}\n`)
		stdout.mockRestore()
	})

	it("emits finalized streamed markdown when stream close has no presentation operation", async () => {
		const taskMessage = {
			id: "task",
			ts: 1,
			content: { type: DiracMessageType.MARKDOWN, content: "do it", role: "user" },
		}
		const streamedMessage = {
			id: "stream-1",
			ts: 2,
			content: { type: DiracMessageType.MARKDOWN, content: "", role: "assistant" },
		}
		const controller = {
			task: {
				taskId: "task-1",
				abortTask: vi.fn(),
				messageStateHandler: { getDiracMessages: () => [] },
			},
			initTask: vi.fn(async () => {
				await mocks.stateSubscriber?.({
					stateJson: JSON.stringify({
						taskStatus: TaskStatus.STREAMING_TEXT,
						diracMessages: [taskMessage, streamedMessage],
						presentationSurfaceId: "task-1",
						presentationOffset: 0,
						activeVoiceStreamId: streamedMessage.id,
						uiActionState: { globalButtons: [], cardButtons: [] },
					}),
				})
				await mocks.stateSubscriber?.({
					stateJson: JSON.stringify({
						taskStatus: TaskStatus.STREAMING_TEXT,
						activeVoiceStreamId: streamedMessage.id,
					}),
					presentationJson: JSON.stringify({
						surfaceId: "task-1",
						operations: [{ offset: 1, type: "append_markdown", id: streamedMessage.id, text: "complete" }],
					}),
				})
				await mocks.stateSubscriber?.({
					stateJson: JSON.stringify({
						taskStatus: TaskStatus.STREAMING_TEXT,
						uiActionState: { globalButtons: [], cardButtons: [] },
					}),
				})
				await mocks.stateSubscriber?.({ stateJson: stateJson(TaskStatus.COMPLETED) })
			}),
		}
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

		await expect(runPlainTextTask({ controller: controller as never, prompt: "do it", jsonOutput: true })).resolves.toBe(true)

		expect(stdout).toHaveBeenCalledWith(
			`${JSON.stringify({
				...streamedMessage,
				content: { ...streamedMessage.content, content: "complete" },
			})}\n`,
		)
		stdout.mockRestore()
	})
})
