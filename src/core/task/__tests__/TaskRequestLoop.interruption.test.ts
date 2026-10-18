import { strict as assert } from "node:assert"
import { DiracError, ErrorService } from "@services/error"
import type { DiracContent } from "@shared/messages/content"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { StreamingMetricsManager } from "../StreamingMetricsManager"
import * as requestAttempt from "../TaskApiRequestAttempt"
import { recursivelyMakeDiracRequests } from "../TaskRequestLoop"
import { TaskState } from "../TaskState"

describe("TaskRequestLoop interrupted response persistence", () => {
	afterEach(() => sinon.restore())

	it("preserves partial assistant output and pairs unexecuted tool calls before surfacing a Goal failure", async () => {
		expectLoggerErrors()
		sinon.stub(ErrorService, "get").returns({ toDiracError: DiracError.transform } as ErrorService)
		sinon.stub(requestAttempt, "attemptApiRequest").callsFake(async function* () {})
		sinon.stub(StreamingMetricsManager.prototype, "updateApiReqMsgFromMetrics").resolves()
		const content: DiracContent[] = [
			{ type: "text", text: "I will update the file." },
			{
				type: "tool_use",
				id: "tool-1",
				call_id: "call-1",
				name: "write_to_file",
				input: { path: "file.ts", content: "new" },
			},
		]
		const addToApiConversationHistory = sinon.stub().resolves()
		const flushPendingWrites = sinon.stub().resolves()
		const taskState = new TaskState()
		const context = {
			taskState,
			executionProfile: "goal_child",
			ulid: "interrupted-child",
			requestRuntime: {
				requestId: "request-1",
				workingConfiguration: {
					settings: { mode: "act" },
					apiConfiguration: { actModeApiProvider: "anthropic" },
				},
				api: { getModel: () => ({ id: "model-1", info: {} }) },
			},
			messageStateHandler: {
				getLatestApiStatusMessage: () => undefined,
				saveDiracMessagesAndUpdateHistory: sinon.stub().resolves(),
				addToApiConversationHistory,
				flushPendingWrites,
			},
			modelContextTracker: { recordModelUsage: sinon.stub().resolves() },
			enqueuePreRequestSteeringMessages: sinon.stub().resolves(),
			handleMistakeLimitReached: async (userContent: DiracContent[]) => ({ didEndLoop: false, userContent }),
			initializeCheckpoints: sinon.stub().resolves(),
			determineContextCompaction: sinon.stub().resolves(false),
			steeringContext: { taskState, withStateLock: async (callback: () => unknown) => callback() },
			apiConversationManager: {
				prepareApiRequest: async ({ userContent }: { userContent: DiracContent[] }) => ({
					userContent,
					lastApiReqIndex: 0,
				}),
			},
			resetStreamingState: sinon.stub().resolves(),
			streamHandler: { getHandlers: () => ({}), getOrderedBlocks: () => content },
			responseProcessor: { consumeStream: sinon.stub().rejects(new Error("socket lost after tool output")) },
			diffViewProvider: { isEditing: false },
		}

		await assert.rejects(recursivelyMakeDiracRequests(context as any, [{ type: "text", text: "Continue" }]), /socket lost/)

		assert.equal(addToApiConversationHistory.callCount, 2)
		const assistant = addToApiConversationHistory.firstCall.args[0]
		assert.equal(assistant.role, "assistant")
		assert.deepEqual(assistant.content.slice(0, 2), content)
		assert.match(assistant.content[2].text, /pending tool calls were not executed/)
		const result = addToApiConversationHistory.secondCall.args[0]
		assert.equal(result.role, "user")
		assert.deepEqual(result.content, [
			{
				type: "tool_result",
				tool_use_id: "tool-1",
				call_id: "call-1",
				is_error: true,
				content: "Not executed: the response stream was interrupted before tool execution.",
			},
		])
		assert.ok(flushPendingWrites.calledAfter(addToApiConversationHistory))
		assert.equal(taskState.didCompleteReadingStream, false)
	})
})
