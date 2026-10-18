import type { ModelInfo } from "./types"

export const unbiasedDefaultModelId = "pareto" as const

// PAYG list prices are estimates; subscription customers are billed by their plan.
// Token limits are listed by OpenRouter for Pareto; Unbiased's direct API docs do not specify them.
export const unbiasedModels = {
	pareto: {
		name: "Pareto",
		contextWindow: 262_144,
		maxTokens: 131_072,
		supportsPromptCache: true,
		supportsImages: true,
		supportsTools: true,
		inputPrice: 2.5,
		outputPrice: 7.5,
		cacheReadsPrice: 0.25,
	},
} as const satisfies Record<string, ModelInfo>
