import "should"
import { clampThinkingBudget, openAiCodexModels, openAiNativeModels, type ModelInfo } from "../api"
import {
    getReasoningEffortOptionsForModel,
    resolveReasoningEffortForModel,
    supportsReasoningEffortForModel,
} from "./reasoning-support"

const constrainedModel: ModelInfo = {
	supportsPromptCache: true,
	supportsReasoningEffort: true,
	reasoningEffortOptions: ["low", "high", "max"],
	defaultReasoningEffort: "max",
}

describe("reasoning support", () => {
	it("uses model-provided effort options", () => {
		getReasoningEffortOptionsForModel("provider/model", constrainedModel).should.deepEqual(["low", "high", "max"])
		supportsReasoningEffortForModel("provider/model", constrainedModel).should.equal(true)
	})

	it("preserves a supported configured effort", () => {
		resolveReasoningEffortForModel("provider/model", constrainedModel, "low")!.should.equal("low")
	})

	it("falls back to the model default for unsupported efforts", () => {
		resolveReasoningEffortForModel("provider/model", constrainedModel, "medium")!.should.equal("max")
	})

	it("falls back to medium instead of sending unsupported none for GPT-6.1 Sol", () => {
		resolveReasoningEffortForModel("gpt-6.1-sol", openAiNativeModels["gpt-6.1-sol"], "none")!.should.equal("medium")
		resolveReasoningEffortForModel("gpt-6.1-sol", openAiCodexModels["gpt-6.1-sol"], "none")!.should.equal("medium")
	})

	describe("clampThinkingBudget", () => {
		it("returns 0 for zero, negative, or undefined budgets", () => {
			clampThinkingBudget(0, constrainedModel).should.equal(0)
			clampThinkingBudget(-100, constrainedModel).should.equal(0)
			clampThinkingBudget(undefined, constrainedModel).should.equal(0)
		})

		it("returns unmodified budget if modelInfo is missing", () => {
			clampThinkingBudget(4096, undefined).should.equal(4096)
		})

		it("clamps to model maxBudget when specified in thinkingConfig", () => {
			const modelWithMaxBudget: ModelInfo = {
				...constrainedModel,
				maxTokens: 64000,
				thinkingConfig: { maxBudget: 24576 },
			}
			clampThinkingBudget(32768, modelWithMaxBudget).should.equal(24576)
			clampThinkingBudget(16384, modelWithMaxBudget).should.equal(16384)
		})

		it("clamps to maxTokens or maxTokens - 1 when requested", () => {
			const modelWithoutMaxBudget: ModelInfo = {
				...constrainedModel,
				maxTokens: 8192,
			}
			clampThinkingBudget(16384, modelWithoutMaxBudget).should.equal(8192)
			clampThinkingBudget(16384, modelWithoutMaxBudget, true).should.equal(8191)
			clampThinkingBudget(4096, modelWithoutMaxBudget).should.equal(4096)
		})
	})
})
