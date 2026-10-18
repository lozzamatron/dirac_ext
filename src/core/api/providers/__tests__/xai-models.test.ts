import { xaiModels } from "@shared/api"
import { expect } from "chai"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { XAIHandler } from "../xai"

async function collect(stream: AsyncIterable<unknown>): Promise<void> {
	for await (const _chunk of stream) {
	}
}

describe("XAIHandler Grok 4.7", () => {
	afterEach(() => sinon.restore())

	it("uses the long-context prices for prompts above 200K tokens", () => {
		const model = xaiModels["grok-4.7"]
		expect(model.contextWindow).to.equal(500_000)
		expect(model.tiers[0]).to.include({ contextWindow: 200_000, inputPrice: 2, cacheReadsPrice: 0.5, outputPrice: 6 })
		expect(model.tiers[1]).to.include({ inputPrice: 4, cacheReadsPrice: 1, outputPrice: 12 })
	})

	it("sends a supported reasoning effort when a saved value cannot disable thinking", async () => {
		const handler = new XAIHandler({ xaiApiKey: "test-api-key", apiModelId: "grok-4.7", reasoningEffort: "none" })
		const create = sinon.stub().resolves({ [Symbol.asyncIterator]: async function* () {} })
		sinon.stub(handler as any, "ensureClient").returns({ chat: { completions: { create } } })

		await collect(handler.createMessage("system", [{ role: "user", content: "hello" }]))

		const [request] = create.firstCall.args
		expect(request.model).to.equal("grok-4.7")
		expect(request.reasoning_effort).to.equal("high")
	})
})
