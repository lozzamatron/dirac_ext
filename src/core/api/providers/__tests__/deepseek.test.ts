import "should"
import sinon from "sinon"
import { deepSeekModels } from "@/shared/api"
import { mockFetchForTesting } from "@/shared/net"
import { DeepSeekHandler } from "../deepseek"

const createAsyncIterable = (data: any[] = []) => ({
	[Symbol.asyncIterator]: async function* () {
		yield* data
	},
})

describe("DeepSeekHandler", () => {
	afterEach(() => sinon.restore())

	it("registers Flash and Pro while retaining Flash capabilities and pricing", () => {
		Object.keys(deepSeekModels).should.deepEqual(["deepseek-flash", "deepseek-v4-pro"])
		deepSeekModels["deepseek-flash"].should.deepEqual({
			maxTokens: 384_000,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			supportsReasoningEffort: true,
			reasoningEffortOptions: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
			defaultReasoningEffort: "high",
			supportsTools: true,
			inputPrice: 0,
			outputPrice: 0.6,
			cacheWritesPrice: 0.15,
			cacheReadsPrice: 0.003,
			pricingSchedule: {
				timeZone: "UTC",
				defaultLabel: "Off-peak",
				periods: [
					{
						label: "Peak",
						weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
						startMinuteUtc: 60,
						endMinuteUtc: 240,
						prices: { inputPrice: 0, outputPrice: 1.2, cacheWritesPrice: 0.3, cacheReadsPrice: 0.006 },
					},
					{
						label: "Peak",
						weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
						startMinuteUtc: 360,
						endMinuteUtc: 600,
						prices: { inputPrice: 0, outputPrice: 1.2, cacheWritesPrice: 0.3, cacheReadsPrice: 0.006 },
					},
				],
			},
		})
	})

	it("normalizes retired DeepSeek model IDs to the canonical Flash model", () => {
		for (const apiModelId of [
			"deepseek-v4-flash",
			"deepseek-v4-flash-vision-exp",
			"deepseek-chat",
			"deepseek-reasoner",
		]) {
			new DeepSeekHandler({ deepSeekApiKey: "test-api-key", apiModelId }).getModel().id.should.equal("deepseek-flash")
		}
	})

	it("sends images to DeepSeek V4.1 Flash as OpenAI image URL blocks", async () => {
		const create = sinon.stub().resolves(createAsyncIterable())
		const handler = new DeepSeekHandler({
			deepSeekApiKey: "test-api-key",
			apiModelId: "deepseek-flash",
		})
		sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create } } })

		for await (const _chunk of handler.createMessage("system", [
			{
				role: "user",
				content: [
					{ type: "text", text: "What is in this image?" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
				],
			},
		])) {
			// Consume the stream so the request is issued.
		}

		const request = create.firstCall.args[0]
		request.model.should.equal("deepseek-flash")
		request.should.not.have.property("max_tokens")
		request.messages.should.deepEqual([
			{ role: "system", content: "system" },
			{
				role: "user",
				content: [
					{ type: "text", text: "What is in this image?" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
				],
			},
		])
	})

	it("sends images returned by tools in a following user message", async () => {
		const create = sinon.stub().resolves(createAsyncIterable())
		const handler = new DeepSeekHandler({
			deepSeekApiKey: "test-api-key",
			apiModelId: "deepseek-flash",
		})
		sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create } } })

		for await (const _chunk of handler.createMessage("system", [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call_1", name: "read_file", input: {} }],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_1",
						content: [
							{ type: "text", text: "Successfully read image" },
							{
								type: "image",
								source: { type: "base64", media_type: "image/png", data: "BASE64_SENTINEL" },
							},
						],
					},
				],
			},
		])) {
			// Consume the stream so the request is issued.
		}

		create.firstCall.args[0].messages.should.deepEqual([
			{ role: "system", content: "system" },
			{
				role: "assistant",
				content: "",
				tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }],
				reasoning_content: "",
			},
			{
				role: "tool",
				tool_call_id: "call_1",
				content: "Successfully read image\n(see following user message for image)",
			},
			{
				role: "user",
				content: [{ type: "image_url", image_url: { url: "data:image/png;base64,BASE64_SENTINEL" } }],
			},
		])
	})

	it("replays reasoning from every prior assistant turn when tools are present", async () => {
		const create = sinon.stub().resolves(createAsyncIterable())
		const handler = new DeepSeekHandler({
			deepSeekApiKey: "test-api-key",
			apiModelId: "deepseek-flash",
		})
		sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create } } })

		for await (const _chunk of handler.createMessage(
			"system",
			[
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "prior reasoning", signature: "" },
						{ type: "text", text: "prior answer" },
					],
				},
				{ role: "user", content: [{ type: "text", text: "continue" }] },
			],
			[
				{
					type: "function",
					function: {
						name: "lookup",
						description: "Look something up",
						parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
					},
				},
			],
		)) {
			// Consume the stream so the request is issued.
		}

		const request = create.firstCall.args[0]
		request.messages[1].should.deepEqual({
			role: "assistant",
			content: "prior answer",
			reasoning_content: "prior reasoning",
		})
		request.tools[0].function.strict.should.equal(true)
		request.thinking.should.deepEqual({ type: "enabled" })
		request.should.not.have.property("extra_body")
		request.should.not.have.property("budget_tokens")
	})

	it("preserves Pro selection with text-only capabilities and unchanged peak/off-peak pricing", () => {
		const model = new DeepSeekHandler({ apiModelId: "deepseek-v4-pro" }).getModel()
		model.id.should.equal("deepseek-v4-pro")
		model.info.supportsImages!.should.equal(false)
		model.info.maxTokens!.should.equal(384_000)
		model.info.contextWindow!.should.equal(1_048_576)
		model.info.outputPrice!.should.equal(1.98)
		model.info.cacheWritesPrice!.should.equal(0.66)
		model.info.cacheReadsPrice!.should.equal(0.022)
		model.info.pricingSchedule!.periods[0].prices.should.deepEqual({
			inputPrice: 0, outputPrice: 3.96, cacheWritesPrice: 1.32, cacheReadsPrice: 0.044,
		})
	})

	for (const apiModelId of ["deepseek-flash", "deepseek-v4-pro"]) {
		for (const reasoningEffort of ["none", "high"]) {
			it(`serializes ${reasoningEffort} thinking at the body root for ${apiModelId}`, async () => {
				let request: Record<string, any> | undefined
				await mockFetchForTesting(async (_input, init) => {
					request = JSON.parse(init!.body as string)
					return new Response([
						": keep-alive\n\n",
						'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
						'data: {"choices":[{"delta":{"content":"pong"}}]}\n\n',
						"data: [DONE]\n\n",
					].join(""), { headers: { "Content-Type": "text/event-stream" } })
				}, async () => {
					const handler = new DeepSeekHandler({ apiModelId, reasoningEffort, deepSeekApiKey: "test-key" })
					const chunks = []
					for await (const chunk of handler.createMessage("system", [{ role: "user", content: "ping" }])) {
						chunks.push(chunk)
					}
					chunks.should.deepEqual([{ type: "text", text: "pong" }])
				})
				request!.model.should.equal(apiModelId)
				request!.thinking.should.deepEqual({ type: reasoningEffort === "none" ? "disabled" : "enabled" })
				request!.should.not.have.property("extra_body")
				request!.should.not.have.property("max_tokens")
				if (reasoningEffort === "none") request!.should.not.have.property("reasoning_effort")
				else request!.reasoning_effort.should.equal("high")
			})
		}
	}

})
