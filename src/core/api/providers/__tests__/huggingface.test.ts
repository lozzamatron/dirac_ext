import "should"
import assert from "node:assert/strict"
import sinon from "sinon"
import { huggingFaceDefaultModelId } from "@/shared/api"
import { HuggingFaceHandler } from "../huggingface"

const emptyStream = {
	[Symbol.asyncIterator]: async function* () {},
}

describe("HuggingFaceHandler", () => {
	afterEach(() => sinon.restore())

	it("keeps a selected model outside the static catalog and uses its saved metadata", () => {
		const info = { supportsPromptCache: false, supportsTools: true, maxTokens: 4096, contextWindow: 32_000 }
		const handler = new HuggingFaceHandler({ huggingFaceModelId: "org/new-model", huggingFaceModelInfo: info })
		handler.getModel().should.deepEqual({ id: "org/new-model", info })
	})

	it("defaults only when no model is selected", () => {
		new HuggingFaceHandler({}).getModel().id.should.equal(huggingFaceDefaultModelId)
		new HuggingFaceHandler({ huggingFaceModelId: "org/custom-model" }).getModel().id.should.equal("org/custom-model")
	})

	it("caps static output tokens, omits sampling parameters, and sends the selected model and tools", async () => {
		const handler = new HuggingFaceHandler({ huggingFaceModelId: "moonshotai/Kimi-K2-Instruct" })
		const create = sinon.stub().resolves(emptyStream)
		sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create } } })
		const tool = { type: "function" as const, function: { name: "read_file", parameters: { type: "object" } } }
		for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }], [tool])) {
			// Consume the stream so the request is sent.
		}
		const params = create.firstCall.args[0]
		params.model.should.equal("moonshotai/Kimi-K2-Instruct")
		params.max_tokens.should.equal(8192)
		params.should.not.have.property("temperature")
		params.tools[0].function.name.should.equal("read_file")
	})

	it("rejects a model known not to support tools before sending a request", async () => {
		const handler = new HuggingFaceHandler({ huggingFaceModelId: "deepseek-ai/DeepSeek-R1" })
		const create = sinon.stub()
		sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create } } })
		await assert.rejects(async () => {
			for await (const _chunk of handler.createMessage("system", [], [{ type: "function", function: { name: "read_file" } } as any])) {
				// Consume the stream to trigger the request.
			}
		}, /does not support tools/)
		create.called.should.equal(false)
	})
})
