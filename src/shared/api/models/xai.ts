import type { ModelInfo } from "./types"
import { MODEL_CAPABILITIES } from "./capabilities"

export type XAIModelId = keyof typeof xaiModels
export const xaiDefaultModelId: XAIModelId = "grok-4-1-fast-reasoning"

export const xaiModels = {
	"grok-4.7": {
		...MODEL_CAPABILITIES["grok-4.7"],
		supportsPromptCache: true,
		inputPrice: 2.0,
		cacheReadsPrice: 0.5,
		outputPrice: 6.0,
		description: "Grok 4.7 for coding and agentic workflows, with configurable reasoning and a 500K context window.",
		tiers: [
			{ contextWindow: 200_000, inputPrice: 2.0, cacheReadsPrice: 0.5, outputPrice: 6.0 },
			{ contextWindow: Number.MAX_SAFE_INTEGER, inputPrice: 4.0, cacheReadsPrice: 1.0, outputPrice: 12.0 },
		],
	},

	"grok-4.6": {
		...MODEL_CAPABILITIES["grok-4.6"],
		supportsPromptCache: true,
		inputPrice: 2.0,
		cacheReadsPrice: 0.5,
		outputPrice: 6.0,
		description:
			"xAI's flagship model for code and general-purpose agentic workflows, with configurable reasoning and a 500K context window.",
		tiers: [
			{
				contextWindow: 200_000,
				inputPrice: 2.0,
				cacheReadsPrice: 0.5,
				outputPrice: 6.0,
			},
			{
				contextWindow: Number.MAX_SAFE_INTEGER,
				inputPrice: 4.0,
				cacheReadsPrice: 1.0,
				outputPrice: 12.0,
			},
		],
	},

	"grok-4-1-fast-reasoning": {
		...MODEL_CAPABILITIES["grok-4-1-fast-reasoning"],
		supportsPromptCache: true,
		inputPrice: 0.2,
		cacheReadsPrice: 0.05,
		outputPrice: 0.5,
		description: "xAI's Grok 4.1 Reasoning Fast - multimodal model with 2M context.",
	},
	"grok-4-1-fast-non-reasoning": {
		...MODEL_CAPABILITIES["grok-4-1-fast-non-reasoning"],
		supportsPromptCache: true,
		inputPrice: 0.2,
		cacheReadsPrice: 0.05,
		outputPrice: 0.5,
		description: "xAI's Grok 4.1 Non-Reasoning Fast - multimodal model with 2M context.",
	},
	"grok-code-fast-1": {
		...MODEL_CAPABILITIES["grok-code-fast-1"],
		supportsPromptCache: true,
		inputPrice: 0.2,
		cacheReadsPrice: 0.02,
		outputPrice: 1.5,
		description: "xAI's Grok Coding model.",
	},
} as const satisfies Record<string, ModelInfo>
