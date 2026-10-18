import "should"
import { createModelSelectionPatch } from "./model-selection"

describe("createModelSelectionPatch", () => {
	const configuration = { actModeApiProvider: "openrouter", planModeApiProvider: "huggingface" } as const

	it("updates only the selected provider and mode when models are separate", async () => {
		const info = { supportsPromptCache: false, maxTokens: 4096 }
		const controller = {
			readOpenRouterModels: async () => ({ "org/model": info }),
		}

		const patch = await createModelSelectionPatch(configuration, "act", "org/model", true, controller)
		patch.should.deepEqual({ actModeOpenRouterModelId: "org/model", actModeOpenRouterModelInfo: info })
	})

	it("clears only Plan Hugging Face metadata when its model ID is cleared", async () => {
		const patch = await createModelSelectionPatch(configuration, "plan", undefined, true)
		patch.should.deepEqual({ planModeHuggingFaceModelId: undefined, planModeHuggingFaceModelInfo: undefined })
	})

	it("updates the correct keys for each provider when Plan and Act share a model", async () => {
		const patch = await createModelSelectionPatch(
			{ actModeApiProvider: "anthropic", planModeApiProvider: "huggingface" },
			"act",
			undefined,
			false,
		)
		patch.should.deepEqual({
			actModeApiModelId: undefined,
			planModeHuggingFaceModelId: undefined,
			planModeHuggingFaceModelInfo: undefined,
		})
	})
})
