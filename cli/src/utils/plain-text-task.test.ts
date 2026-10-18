import {
	CardStatus,
	type Card,
	DiracMessageType,
	TaskStatus,
	UIActionButtonType,
	type ExtensionState,
} from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	approveCardForPlainTextYolo,
	getStandaloneCardDisposition,
	StandaloneCardDisposition,
} from "./standalone-card-policy"
import { emitTaskStartedMessage } from "./task-start-output"
import { evaluatePlainTextTaskTerminalState, runPlainTextTask } from "./plain-text-task"
import type { Controller } from "@/core/controller"
import { subscribeToState } from "@/core/controller/state/subscribeToState"

vi.mock("@/core/controller/state/subscribeToState", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/core/controller/state/subscribeToState")>()
	return { ...actual, subscribeToState: vi.fn(async () => {}) }
})
vi.mock("@/core/controller/task/showTaskWithId", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/core/controller/task/showTaskWithId")>()
	return { ...actual, showTaskWithId: vi.fn(async () => ({})) }
})
vi.mock("@/core/controller/grpc-handler", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/core/controller/grpc-handler")>()
	return { ...actual, getRequestRegistry: vi.fn(() => ({ cancelRequest: vi.fn() })) }
})

describe("emitTaskStartedMessage", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("writes structured task_started JSON to stdout in json mode", () => {
		const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
		const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

		emitTaskStartedMessage("task-123", true)

		expect(stdoutWriteSpy).toHaveBeenCalledWith('{"type":"task_started","taskId":"task-123"}\n')
		expect(stderrWriteSpy).not.toHaveBeenCalled()
	})

	it("writes human-readable task started line to stderr in non-json mode", () => {
		const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
		const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

		emitTaskStartedMessage("task-456", false)

		expect(stderrWriteSpy).toHaveBeenCalledWith("Task started: task-456\n")
		expect(stdoutWriteSpy).not.toHaveBeenCalled()
	})
})


describe("approveCardForPlainTextYolo", () => {
	it("forwards the primary action value when approving a new-task card", async () => {
		const submitCardResponse = vi.fn().mockResolvedValue(undefined)
		const controller = { task: { submitCardResponse } }
		const card: Card = {
			id: "new-task-card",
			header: "New Task",
			status: CardStatus.WAITING_FOR_INPUT,
			renderType: "markdown",
			actions: [{ label: "Approve New Task", value: "new_task", primary: true }],
		}

		await approveCardForPlainTextYolo(controller, card)

		expect(submitCardResponse).toHaveBeenCalledWith(
			card.id,
			DiracAskResponse.APPROVE,
			undefined,
			undefined,
			undefined,
			"new_task",
		)
	})

	it("fails when no active task can receive the approval", async () => {
		const controller = { task: undefined }
		const card = {
			id: "approval-card",
			header: "Approval",
			status: CardStatus.WAITING_FOR_INPUT,
			renderType: "markdown",
		} as Card

		await expect(approveCardForPlainTextYolo(controller, card)).rejects.toThrow("without an active task")
	})
})

describe("getStandaloneCardDisposition", () => {
	const waitingCard = {
		id: "card",
		header: "Card",
		status: CardStatus.WAITING_FOR_INPUT,
		renderType: "markdown",
	} as Card

	it("auto-approves approval cards only in yolo mode", () => {
		expect(getStandaloneCardDisposition({ ...waitingCard, requireApproval: true }, true, false)).toBe(
			StandaloneCardDisposition.AUTO_APPROVE,
		)
		expect(getStandaloneCardDisposition({ ...waitingCard, requireApproval: true }, false, false)).toBe(
			StandaloneCardDisposition.FAIL_FOR_APPROVAL,
		)
	})

	it("never fabricates feedback in yolo mode", () => {
		expect(getStandaloneCardDisposition({ ...waitingCard, requireFeedback: true }, true, false)).toBe(
			StandaloneCardDisposition.FAIL_FOR_FEEDBACK,
		)
	})

	it("does not act on interaction cards while only viewing history", () => {
		expect(getStandaloneCardDisposition({ ...waitingCard, requireApproval: true }, true, true)).toBe(
			StandaloneCardDisposition.NONE,
		)
	})
})

describe("evaluatePlainTextTaskTerminalState", () => {
	it("rejects immediately when a Task Failed error card is present", () => {
		const state = {
			taskStatus: TaskStatus.EXECUTING_TOOL,
			diracMessages: [
				{
					id: "1",
					ts: Date.now(),
					content: {
						type: DiracMessageType.CARD,
						card: {
							id: "fail-card",
							header: "Task Failed",
							status: CardStatus.ERROR,
							body: "[YOLO MODE] Task failed: Too many consecutive mistakes (3).",
							renderType: "markdown",
						},
					},
				},
			],
		} as unknown as ExtensionState

		const result = evaluatePlainTextTaskTerminalState(state)
		expect(result.isTerminal).toBe(true)
		expect(result.action).toBe("reject")
		expect(result.error?.message).toBe("[YOLO MODE] Task failed: Too many consecutive mistakes (3).")
	})

	it("resolves when taskStatus is COMPLETED", () => {
		const state = {
			taskStatus: TaskStatus.COMPLETED,
		} as unknown as ExtensionState

		const result = evaluatePlainTextTaskTerminalState(state)
		expect(result.isTerminal).toBe(true)
		expect(result.action).toBe("resolve")
	})

	it("rejects when taskStatus is CANCELLED in normal execution", () => {
		const state = {
			taskStatus: TaskStatus.CANCELLED,
		} as unknown as ExtensionState

		const result = evaluatePlainTextTaskTerminalState(state, false)
		expect(result.isTerminal).toBe(true)
		expect(result.action).toBe("reject")
		expect(result.error?.message).toBe("Task was cancelled.")
	})

	it("resolves when taskStatus is CANCELLED in isViewTaskOnly mode", () => {
		const state = {
			taskStatus: TaskStatus.CANCELLED,
		} as unknown as ExtensionState

		const result = evaluatePlainTextTaskTerminalState(state, true)
		expect(result.isTerminal).toBe(true)
		expect(result.action).toBe("resolve")
	})

	it("rejects when global buttons have both NEW_TASK and PROCEED (mistake limit projection)", () => {
		const state = {
			taskStatus: TaskStatus.EXECUTING_TOOL,
			uiActionState: {
				globalButtons: [
					{ action: UIActionButtonType.NEW_TASK },
					{ action: UIActionButtonType.PROCEED },
				],
			},
		} as unknown as ExtensionState

		const result = evaluatePlainTextTaskTerminalState(state)
		expect(result.isTerminal).toBe(true)
		expect(result.action).toBe("reject")
		expect(result.error?.message).toBe("Mistake limit reached. Task halted in YOLO mode.")
	})

	it("returns non-terminal when task is running without terminal signals", () => {
		const state = {
			taskStatus: TaskStatus.EXECUTING_TOOL,
			uiActionState: {
				globalButtons: [],
			},
		} as unknown as ExtensionState

		const result = evaluatePlainTextTaskTerminalState(state)
		expect(result.isTerminal).toBe(false)
	})

	it("ignores a Task Failed card created before the turn cutoff", () => {
		const state = {
			taskStatus: TaskStatus.EXECUTING_TOOL,
			diracMessages: [
				{
					id: "old-fail",
					ts: 500,
					content: {
						type: DiracMessageType.CARD,
						card: {
							id: "old-fail",
							header: "Task Failed",
							status: CardStatus.ERROR,
							body: "old failure",
							renderType: "markdown",
						},
					},
				},
			],
		} as unknown as ExtensionState

		const result = evaluatePlainTextTaskTerminalState(state, false, 1000)
		expect(result.isTerminal).toBe(false)
	})

	it("rejects on a Task Failed card created at or after the turn cutoff", () => {
		const state = {
			taskStatus: TaskStatus.EXECUTING_TOOL,
			diracMessages: [
				{
					id: "new-fail",
					ts: 1500,
					content: {
						type: DiracMessageType.CARD,
						card: {
							id: "new-fail",
							header: "Task Failed",
							status: CardStatus.ERROR,
							body: "new failure",
							renderType: "markdown",
						},
					},
				},
			],
		} as unknown as ExtensionState

		const result = evaluatePlainTextTaskTerminalState(state, false, 1000)
		expect(result.isTerminal).toBe(true)
		expect(result.action).toBe("reject")
		expect(result.error?.message).toBe("new failure")
	})

	it("rejects with the newest failure card when history mixes old and new", () => {
		const failureCard = (id: string, ts: number, body: string) => ({
			id,
			ts,
			content: {
				type: DiracMessageType.CARD,
				card: { id, header: "Task Failed", status: CardStatus.ERROR, body, renderType: "markdown" },
			},
		})
		const state = {
			taskStatus: TaskStatus.EXECUTING_TOOL,
			diracMessages: [failureCard("old", 500, "old failure"), failureCard("new", 1500, "new failure")],
		} as unknown as ExtensionState

		const result = evaluatePlainTextTaskTerminalState(state, false, 1000)
		expect(result.isTerminal).toBe(true)
		expect(result.error?.message).toBe("new failure")
	})
})

describe("runPlainTextTask resumed history", () => {
	const oldFailedCard = {
		id: "old-fail-card",
		ts: 1, // persisted history — long before the follow-up turn
		content: {
			type: DiracMessageType.CARD,
			card: {
				id: "old-fail-card",
				header: "Task Failed",
				status: CardStatus.ERROR,
				body: "old mistake limit",
				renderType: "markdown",
			},
		},
	}

	function setup() {
		let stateCb: Parameters<typeof subscribeToState>[2] | undefined
		vi.mocked(subscribeToState).mockImplementation(async (_controller, _request, cb) => {
			stateCb = cb
		})
		const submitCardResponse = vi.fn(async () => ({}))
		const controller = {
			task: {
				taskId: "t1",
				submitCardResponse,
				abortTask: vi.fn(async () => {}),
				messageStateHandler: { getDiracMessages: () => [] },
			},
		} as unknown as Controller
		return {
			controller,
			submitCardResponse,
			getStateCb: () => {
				if (!stateCb) {
					throw new Error("subscription callback was not registered")
				}
				return stateCb
			},
		}
	}

	it("does not reject a follow-up turn when a historical Task Failed card arrives late", async () => {
		const { controller, submitCardResponse, getStateCb } = setup()
		const runPromise = runPlainTextTask({ controller, taskId: "t1", prompt: "continue" })
		await vi.waitFor(() => expect(submitCardResponse).toHaveBeenCalledTimes(1))
		const stateCb = getStateCb()

		// Persisted history arriving after the new turn started must not settle the run
		await stateCb({
			stateJson: JSON.stringify({ taskStatus: TaskStatus.EXECUTING_TOOL, diracMessages: [oldFailedCard] }),
		} as never)
		await stateCb({ stateJson: JSON.stringify({ taskStatus: TaskStatus.COMPLETED }) } as never)

		await expect(runPromise).resolves.toBe(true)
	})

	it("still rejects a follow-up turn on a Task Failed card created during the new turn", async () => {
		const { controller, submitCardResponse, getStateCb } = setup()
		const runPromise = runPlainTextTask({ controller, taskId: "t1", prompt: "continue" })
		await vi.waitFor(() => expect(submitCardResponse).toHaveBeenCalledTimes(1))
		const stateCb = getStateCb()

		const newFailedCard = {
			...oldFailedCard,
			id: "new-fail-card",
			ts: Date.now(),
			content: {
				...oldFailedCard.content,
				card: { ...oldFailedCard.content.card, id: "new-fail-card", body: "new mistake limit" },
			},
		}
		await stateCb({
			stateJson: JSON.stringify({
				taskStatus: TaskStatus.EXECUTING_TOOL,
				diracMessages: [oldFailedCard, newFailedCard],
			}),
		} as never)

		await expect(runPromise).resolves.toBe(false)
	})
})
