import "should"
import { parseHuggingFaceRouterModels } from "../refreshHuggingFaceModels"

describe("parseHuggingFaceRouterModels", () => {
	it("lists only live tool-capable routes with conservative limits and no invented price", () => {
		const models = parseHuggingFaceRouterModels([
			{
				id: "org/tool-model",
				architecture: { input_modalities: ["text", "image"] },
				providers: [
					{ provider: "fast", status: "live", supports_tools: true, context_length: 64_000 },
					{ provider: "slow", status: "live", supports_tools: true, context_length: 32_000 },
					{ provider: "no-tools", status: "live", supports_tools: false, context_length: 16_000 },
				],
			},
			{ id: "org/no-tools", providers: [{ provider: "a", status: "live", supports_tools: false }] },
			{ id: "org/offline", providers: [{ provider: "a", status: "offline", supports_tools: true }] },
		])

		Object.keys(models).should.deepEqual(["org/tool-model"])
		const info = models["org/tool-model"]
		info.contextWindow!.should.equal(32_000)
		info.maxTokens!.should.equal(8192)
		info.supportsImages!.should.equal(true)
		info.supportsTools!.should.equal(true)
		info.should.not.have.property("inputPrice")
		info.should.not.have.property("outputPrice")
	})
})
