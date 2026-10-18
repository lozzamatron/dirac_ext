import "should"
import sinon from "sinon"
import { describe, it, afterEach } from "mocha"
import { OpenAiHandler } from "../openai"

const createAsyncIterable = (data: any[] = []) => ({
	[Symbol.asyncIterator]: async function* () {
		yield* data
	},
})

const captureRequest = async (reasoningEffort?: string) => {
	const handler = new OpenAiHandler({
		openAiApiKey: "test-key",
		openAiBaseUrl: "http://127.0.0.1:11434/v1",
		openAiModelId: "qwen3.8:27b-mlx-64k",
		reasoningEffort,
	} as any)
	const create = sinon.stub().resolves(createAsyncIterable())
	sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create } } } as any)

	for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "hi" }] as any)) {
		// consume
	}
	return create.firstCall.args[0]
}

describe("openai-compatible reasoning_effort", () => {
	afterEach(() => sinon.restore())

	it("sends reasoning_effort: none rather than omitting the field", async () => {
		const request = await captureRequest("none")

		// Omitting lets the server default apply, which leaves reasoning ON for some backends.
		request.should.have.property("reasoning_effort", "none")
	})

	it("sends the selected effort unchanged", async () => {
		const request = await captureRequest("high")

		request.should.have.property("reasoning_effort", "high")
	})

	it("falls back to the default effort when unset", async () => {
		const request = await captureRequest(undefined)

		request.should.have.property("reasoning_effort", "high")
	})
})
