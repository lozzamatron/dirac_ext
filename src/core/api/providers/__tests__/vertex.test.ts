import "should"
import { vertexDefaultModelId, vertexModels } from "@shared/api"
import { expect } from "chai"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { VertexHandler } from "../vertex"

describe("VertexHandler", () => {
	afterEach(() => sinon.restore())

	// Helper: build an async iterable from a list of stream chunks
	const createAsyncIterable = (data: readonly unknown[] = []) => ({
		[Symbol.asyncIterator]: async function* () {
			yield* data
		},
	})

	// Helper: collect all chunks from createMessage into an array
	const collect = async (gen: AsyncIterable<unknown>) => {
		const chunks: any[] = []
		for await (const chunk of gen) chunks.push(chunk)
		return chunks
	}

	// Helper: build a stubbed Anthropic client whose beta.messages.create resolves to the given stream
	const stubAnthropicClient = (handler: VertexHandler, stream: unknown) => {
		const createStub = sinon.stub().resolves(stream)
		sinon.stub(handler as any, "ensureAnthropicClient").returns({ beta: { messages: { create: createStub } } })
		return createStub
	}

	// Helper: configure handler for a Claude model so the Anthropic path is taken
	const stubClaudeModel = (handler: VertexHandler, id: string, infoOverrides: Record<string, unknown> = {}) => {
		sinon
			.stub(handler, "getModel")
			.returns({ id: id as any, info: { ...vertexModels["claude-sonnet-4-6"], ...infoOverrides } as any })
	}

	describe("getModel", () => {
		it("should return the default model when no apiModelId is configured", () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			const result = handler.getModel()
			result.id.should.equal(vertexDefaultModelId)
			result.info.should.deepEqual((vertexModels as any)[vertexDefaultModelId])
		})

		it("should return the configured model when apiModelId is a known vertex model", () => {
			const handler = new VertexHandler({
				vertexProjectId: "proj",
				vertexRegion: "us-east1",
				apiModelId: "claude-sonnet-4-6",
			})
			const result = handler.getModel()
			result.id.should.equal("claude-sonnet-4-6")
			result.info.should.deepEqual(vertexModels["claude-sonnet-4-6"])
		})

		it("should fall back to the default model when apiModelId is not a known vertex model", () => {
			const handler = new VertexHandler({
				vertexProjectId: "proj",
				vertexRegion: "us-east1",
				apiModelId: "nonexistent-model",
			})
			const result = handler.getModel()
			result.id.should.equal(vertexDefaultModelId)
		})
	})

	describe("createMessage - Gemini routing", () => {
		it("should delegate to the Gemini handler for non-claude models", async () => {
			const handler = new VertexHandler({
				vertexProjectId: "proj",
				vertexRegion: "us-east1",
				apiModelId: "gemini-3-pro-preview",
			})
			const geminiChunks = [{ type: "text", text: "hello from gemini" }]
			// createMessage is an async generator; calling it returns an async iterable directly
			const fakeGeminiHandler = { createMessage: sinon.stub().returns(createAsyncIterable(geminiChunks)) }
			sinon.stub(handler as any, "ensureGeminiHandler").returns(fakeGeminiHandler)

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			sinon.assert.calledOnce(fakeGeminiHandler.createMessage)
			chunks.should.deepEqual(geminiChunks)
		})

		it("should propagate errors thrown by the Gemini handler", async () => {
			const handler = new VertexHandler({
				vertexProjectId: "proj",
				vertexRegion: "us-east1",
				apiModelId: "gemini-3-pro-preview",
			})
			const throwingIterable = {
				[Symbol.asyncIterator]: async function* () {
					throw new Error("gemini boom")
				},
			}
			const fakeGeminiHandler = { createMessage: sinon.stub().returns(throwingIterable) }
			sinon.stub(handler as any, "ensureGeminiHandler").returns(fakeGeminiHandler)

			await collect(handler.createMessage("system", [{ role: "user", content: "hi" }])).should.be.rejectedWith(
				"gemini boom",
			)
		})

		it("should delegate abort to the Gemini handler", () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			const abort = sinon.stub()
			;(handler as any).geminiHandler = { abort }

			handler.abort()

			sinon.assert.calledOnce(abort)
		})
	})

	describe("createMessage - Anthropic stream parsing", () => {
		it("should abort a stalled Claude request", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			let requestSignal: AbortSignal | undefined
			const createStub = sinon.stub().callsFake((_params: unknown, options: { signal: AbortSignal }) => {
				requestSignal = options.signal
				return new Promise((_resolve, reject) => {
					requestSignal?.addEventListener("abort", () => reject(new Error("Vertex request aborted")), { once: true })
				})
			})
			sinon.stub(handler as any, "ensureAnthropicClient").returns({ beta: { messages: { create: createStub } } })

			const pendingChunk = handler
				.createMessage("system", [{ role: "user", content: "hi" }])
				[Symbol.asyncIterator]()
				.next()

			sinon.assert.calledOnce(createStub)
			handler.abort()

			expect(requestSignal).not.to.be.undefined
			requestSignal!.aborted.should.equal(true)
			await pendingChunk.should.be.rejectedWith("Vertex request aborted")
			expect((handler as any).abortController).to.be.undefined
		})

		it("should not start another Claude request when aborted during a retry delay", async () => {
			const clock = sinon.useFakeTimers()
			let notifyRetryStarted!: () => void
			const retryStarted = new Promise<void>((resolve) => {
				notifyRetryStarted = resolve
			})
			const handler = new VertexHandler({
				vertexProjectId: "proj",
				vertexRegion: "us-east1",
				onRetryAttempt: () => notifyRetryStarted(),
			})
			stubClaudeModel(handler, "claude-sonnet-4-6")
			const rateLimitError = Object.assign(new Error("rate limited"), { status: 429 })
			const createStub = sinon.stub().rejects(rateLimitError)
			sinon.stub(handler as any, "ensureAnthropicClient").returns({ beta: { messages: { create: createStub } } })

			const pendingChunk = handler
				.createMessage("system", [{ role: "user", content: "hi" }])
				[Symbol.asyncIterator]()
				.next()
			const rejectedChunk = pendingChunk.should.be.rejected()
			await retryStarted

			handler.abort()
			await clock.tickAsync(1_000)
			await rejectedChunk

			sinon.assert.calledOnce(createStub)
		})

		it("should emit a usage chunk from message_start with cache tokens", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			const createStub = stubAnthropicClient(
				handler,
				createAsyncIterable([
					{
						type: "message_start",
						message: {
							usage: {
								input_tokens: 10,
								output_tokens: 5,
								cache_creation_input_tokens: 3,
								cache_read_input_tokens: 2,
							},
						},
					},
				]),
			)

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([
				{ type: "usage", inputTokens: 10, outputTokens: 5, cacheWriteTokens: 3, cacheReadTokens: 2 },
			])
			sinon.assert.calledOnce(createStub)
		})

		it("should default missing usage fields to 0 in message_start", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			stubAnthropicClient(handler, createAsyncIterable([{ type: "message_start", message: { usage: {} } }]))

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([
				{ type: "usage", inputTokens: 0, outputTokens: 0, cacheWriteTokens: undefined, cacheReadTokens: undefined },
			])
		})

		it("should emit a usage chunk from message_delta with output tokens", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			stubAnthropicClient(handler, createAsyncIterable([{ type: "message_delta", usage: { output_tokens: 42 } }]))

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([{ type: "usage", inputTokens: 0, outputTokens: 42 }])
		})

		it("should default output tokens to 0 when message_delta usage is missing", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			stubAnthropicClient(handler, createAsyncIterable([{ type: "message_delta" }]))

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([{ type: "usage", inputTokens: 0, outputTokens: 0 }])
		})

		it("should emit text from content_block_start at index 0 without a leading newline", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			stubAnthropicClient(
				handler,
				createAsyncIterable([{ type: "content_block_start", index: 0, content_block: { type: "text", text: "first" } }]),
			)

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([{ type: "text", text: "first" }])
		})

		it("should emit a leading newline before text when content_block_start index > 0", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			stubAnthropicClient(
				handler,
				createAsyncIterable([{ type: "content_block_start", index: 1, content_block: { type: "text", text: "second" } }]),
			)

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([
				{ type: "text", text: "\n" },
				{ type: "text", text: "second" },
			])
		})

		it("should emit text deltas from text_delta chunks", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			stubAnthropicClient(
				handler,
				createAsyncIterable([
					{ type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
					{ type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
				]),
			)

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([
				{ type: "text", text: "Hel" },
				{ type: "text", text: "lo" },
			])
		})

		it("should emit reasoning from a thinking content_block_start", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			stubAnthropicClient(
				handler,
				createAsyncIterable([
					{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "initial thought" } },
				]),
			)

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([{ type: "reasoning", reasoning: "initial thought" }])
		})

		it("should emit reasoning from thinking_delta chunks", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			stubAnthropicClient(
				handler,
				createAsyncIterable([
					{ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "more thought" } },
				]),
			)

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([{ type: "reasoning", reasoning: "more thought" }])
		})

		it("should emit reasoning with a signature from signature_delta chunks", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			stubAnthropicClient(
				handler,
				createAsyncIterable([{ type: "content_block_delta", delta: { type: "signature_delta", signature: "sig-abc" } }]),
			)

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([{ type: "reasoning", reasoning: "", signature: "sig-abc" }])
		})

		it("should emit a redacted thinking block as reasoning", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			stubAnthropicClient(
				handler,
				createAsyncIterable([{ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking" } }]),
			)

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([{ type: "reasoning", reasoning: "[Redacted thinking block]" }])
		})

		it("should emit tool_calls from tool_use start followed by input_json_delta", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			stubAnthropicClient(
				handler,
				createAsyncIterable([
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "tool_1", name: "get_weather" },
					},
					{ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"city":"SF"}' } },
				]),
			)

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([
				{
					type: "tool_calls",
					tool_call: {
						id: "tool_1",
						name: "get_weather",
						arguments: "",
						function: { id: "tool_1", name: "get_weather", arguments: '{"city":"SF"}' },
					},
				},
			])
		})

		it("should not emit tool_calls when tool_use start is missing id or name", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			stubAnthropicClient(
				handler,
				createAsyncIterable([
					{ type: "content_block_start", index: 0, content_block: { type: "tool_use" } },
					{ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"x":1}' } },
				]),
			)

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([])
		})

		it("should not emit tool_calls for input_json_delta when partial_json is missing", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			stubAnthropicClient(
				handler,
				createAsyncIterable([
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "tool_1", name: "get_weather" },
					},
					{ type: "content_block_delta", delta: { type: "input_json_delta" } },
				]),
			)

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([])
		})

		it("should reset the active tool call on content_block_stop", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			// After a stop, a subsequent input_json_delta should not emit because the call was reset
			stubAnthropicClient(
				handler,
				createAsyncIterable([
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "tool_1", name: "get_weather" },
					},
					{ type: "content_block_stop" },
					{ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"late":true}' } },
				]),
			)

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([])
		})

		it("should ignore message_stop chunks", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			stubAnthropicClient(handler, createAsyncIterable([{ type: "message_stop" }]))

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([])
		})

		it("should ignore chunks with an unknown type", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			stubAnthropicClient(
				handler,
				createAsyncIterable([
					{ type: "some_unknown_event" },
					{ type: "content_block_delta", delta: { type: "unknown_delta" } },
				]),
			)

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([])
		})

		it("should ignore chunks with a null/undefined type", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			stubAnthropicClient(handler, createAsyncIterable([undefined, null, { type: undefined }]))

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([])
		})
	})

	describe("createMessage - canonical model IDs", () => {
		it("sends a canonical Claude model ID unchanged without a legacy beta header", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			const createStub = stubAnthropicClient(handler, createAsyncIterable([]))

			await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			const [params, options] = createStub.firstCall.args
			params.model.should.equal("claude-sonnet-4-6")
			expect(options.signal.aborted).to.equal(false)
			expect(options).not.to.have.property("headers")
		})
	})

	describe("createMessage - reasoning configuration", () => {
		it("sends Opus 5.5 with adaptive thinking and medium effort even without a thinking budget", async () => {
			const handler = new VertexHandler({
				vertexProjectId: "proj",
				vertexRegion: "us-east1",
				apiModelId: "claude-opus-5-5",
			})
			const create = stubAnthropicClient(handler, createAsyncIterable([]))

			await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			const [request] = create.firstCall.args
			request.model.should.equal("claude-opus-5-5")
			request.thinking.should.deepEqual({ type: "adaptive", display: "summarized" })
			request.output_config.should.deepEqual({ effort: "medium" })
		})

		it("should enable adaptive thinking when supported and budget is non-zero", async () => {
			const handler = new VertexHandler({
				vertexProjectId: "proj",
				vertexRegion: "us-east1",
				thinkingBudgetTokens: 1024,
				reasoningEffort: "medium",
			})
			stubClaudeModel(handler, "claude-sonnet-4-6", { supportsReasoning: true })
			const createStub = stubAnthropicClient(handler, createAsyncIterable([]))

			await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			const [params] = createStub.firstCall.args
			// adaptive thinking path: temperature undefined, output_config effort set
			expect(params.temperature).to.be.undefined
			params.thinking.should.deepEqual({ type: "adaptive", display: "summarized" })
			params.output_config.should.deepEqual({ effort: "medium" })
		})

		it("should enable fixed-budget thinking when not adaptive and budget is non-zero", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1", thinkingBudgetTokens: 512 })
			stubClaudeModel(handler, "claude-sonnet-4-6", { supportsReasoning: true, supportsAdaptiveThinking: false })
			const createStub = stubAnthropicClient(handler, createAsyncIterable([]))

			await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			const [params] = createStub.firstCall.args
			params.thinking.should.deepEqual({ type: "enabled", budget_tokens: 512 })
			expect(params.output_config).to.be.undefined
		})

		it("should disable thinking when budget is zero even if supported", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1", thinkingBudgetTokens: 0 })
			stubClaudeModel(handler, "claude-sonnet-4-6", { supportsReasoning: true })
			const createStub = stubAnthropicClient(handler, createAsyncIterable([]))

			await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			const [params] = createStub.firstCall.args
			expect(params.thinking).to.be.undefined
		})
	})

	describe("createMessage - tools", () => {
		it("should pass tools and set tool_choice to any when native tools are on and reasoning is off", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			const createStub = stubAnthropicClient(handler, createAsyncIterable([]))
			const tools = [
				{ name: "get_weather", description: "get weather", input_schema: { type: "object", properties: {} } },
			] as any

			await collect(handler.createMessage("system", [{ role: "user", content: "hi" }], tools))

			const [params] = createStub.firstCall.args
			params.tools.should.deepEqual(tools)
			params.tool_choice.should.deepEqual({ type: "any" })
		})

		it("should not set tool_choice when reasoning is on, even with tools", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1", thinkingBudgetTokens: 512 })
			stubClaudeModel(handler, "claude-sonnet-4-6", { supportsReasoning: true })
			const createStub = stubAnthropicClient(handler, createAsyncIterable([]))
			const tools = [{ name: "get_weather", description: "get weather", input_schema: {} }] as any

			await collect(handler.createMessage("system", [{ role: "user", content: "hi" }], tools))

			const [params] = createStub.firstCall.args
			params.tools.should.deepEqual(tools)
			expect(params.tool_choice).to.be.undefined
		})

		it("should omit tools and tool_choice when no tools are provided", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			const createStub = stubAnthropicClient(handler, createAsyncIterable([]))

			await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			const [params] = createStub.firstCall.args
			expect(params.tools).to.be.undefined
			expect(params.tool_choice).to.be.undefined
		})
	})

	describe("createMessage - error handling", () => {
		it("should throw when vertexProjectId is missing", async () => {
			const handler = new VertexHandler({ vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")

			await collect(handler.createMessage("system", [{ role: "user", content: "hi" }])).should.be.rejectedWith(
				/Vertex AI project ID is required/,
			)
		})

		it("should throw when vertexRegion is missing", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj" })
			stubClaudeModel(handler, "claude-sonnet-4-6")

			await collect(handler.createMessage("system", [{ role: "user", content: "hi" }])).should.be.rejectedWith(
				/Vertex AI region is required/,
			)
		})

		it("should throw when the Anthropic client constructor fails", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			// Force ensureAnthropicClient to run the real constructor path by stubbing buildExternalBasicHeaders to throw
			const envUtils = require("@/services/EnvUtils")
			sinon.stub(envUtils, "buildExternalBasicHeaders").throws(new Error("env failure"))

			await collect(handler.createMessage("system", [{ role: "user", content: "hi" }])).should.be.rejectedWith(
				/Vertex AI Anthropic client/,
			)
		})

		it("should propagate errors thrown by the Anthropic stream create", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			const createStub = sinon.stub().rejects(new Error("anthropic create failed"))
			sinon.stub(handler as any, "ensureAnthropicClient").returns({ beta: { messages: { create: createStub } } })

			await collect(handler.createMessage("system", [{ role: "user", content: "hi" }])).should.be.rejectedWith(
				"anthropic create failed",
			)
		})

		it("should propagate errors thrown mid-stream iteration", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			const failingStream = {
				[Symbol.asyncIterator]: async function* () {
					yield { type: "message_start", message: { usage: { input_tokens: 1 } } }
					throw new Error("stream broke")
				},
			}
			stubAnthropicClient(handler, failingStream)

			await collect(handler.createMessage("system", [{ role: "user", content: "hi" }])).should.be.rejectedWith(
				"stream broke",
			)
		})
	})

	describe("createMessage - edge cases", () => {
		it("should produce no chunks for an empty stream", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			stubAnthropicClient(handler, createAsyncIterable([]))

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([])
		})

		it("should yield undefined text when text_delta has no text field", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			stubAnthropicClient(handler, createAsyncIterable([{ type: "content_block_delta", delta: { type: "text_delta" } }]))

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([{ type: "text", text: undefined }])
		})

		it("should yield undefined reasoning when thinking_delta has no thinking field", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6")
			stubAnthropicClient(
				handler,
				createAsyncIterable([{ type: "content_block_delta", delta: { type: "thinking_delta" } }]),
			)

			const chunks = await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			chunks.should.deepEqual([{ type: "reasoning", reasoning: undefined }])
		})

		it("should use max_tokens from model info when provided", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6", { maxTokens: 4096 })
			const createStub = stubAnthropicClient(handler, createAsyncIterable([]))

			await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			const [params] = createStub.firstCall.args
			params.max_tokens.should.equal(4096)
		})

		it("should default max_tokens to 8192 when model info has no maxTokens", async () => {
			const handler = new VertexHandler({ vertexProjectId: "proj", vertexRegion: "us-east1" })
			stubClaudeModel(handler, "claude-sonnet-4-6", { maxTokens: undefined })
			const createStub = stubAnthropicClient(handler, createAsyncIterable([]))

			await collect(handler.createMessage("system", [{ role: "user", content: "hi" }]))

			const [params] = createStub.firstCall.args
			params.max_tokens.should.equal(8192)
		})
	})
})
