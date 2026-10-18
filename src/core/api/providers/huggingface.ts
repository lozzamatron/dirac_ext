import { huggingFaceDefaultModelId, huggingFaceModels, type ModelInfo } from "@shared/api"
import { calculateApiCostOpenAI } from "@utils/cost"
import OpenAI from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { DiracStorageMessage } from "@/shared/messages/content"
import { createOpenAIClient } from "@/shared/net"
import { ApiHandler, CommonApiHandlerOptions } from "../"
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"

interface HuggingFaceHandlerOptions extends CommonApiHandlerOptions {
	huggingFaceApiKey?: string
	huggingFaceModelId?: string
	huggingFaceModelInfo?: ModelInfo
}

export class HuggingFaceHandler implements ApiHandler {
	private options: HuggingFaceHandlerOptions
	private client: OpenAI | undefined
	private cachedModel: { id: string; info: ModelInfo } | undefined

	constructor(options: HuggingFaceHandlerOptions) {
		this.options = options
	}

	private ensureClient(): OpenAI {
		if (!this.client) {
			if (!this.options.huggingFaceApiKey) {
				throw new Error("Hugging Face API key is required")
			}

			try {
				this.client = createOpenAIClient({
					baseURL: "https://router.huggingface.co/v1",
					apiKey: this.options.huggingFaceApiKey,
				})
			} catch (error: any) {
				throw new Error(`Error creating Hugging Face client: ${error.message}`)
			}
		}
		return this.client
	}

	private async *yieldUsage(info: ModelInfo, usage: OpenAI.Completions.CompletionUsage | undefined): ApiStream {
		if (!usage) {
			return
		}

		const inputTokens = usage.prompt_tokens || 0
		const outputTokens = usage.completion_tokens || 0
		const totalCost = calculateApiCostOpenAI(info, inputTokens, outputTokens)

		const usageData = {
			type: "usage" as const,
			inputTokens: inputTokens,
			outputTokens: outputTokens,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
			totalCost: totalCost,
		}

		yield usageData
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: DiracStorageMessage[], tools?: OpenAITool[]): ApiStream {
		const model = this.getModel()
		if (tools?.length && model.info.supportsTools === false) {
			throw new Error(`Hugging Face model ${model.id} does not support tools; select a tool-capable model`)
		}

		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages, undefined, model.info.supportsImages !== false),
		]

		const stream = await this.ensureClient().chat.completions.create({
			model: model.id,
			// Provider context limits include the prompt. Cap old static and saved limits to leave room for input.
			...(model.info.maxTokens ? { max_tokens: Math.min(8192, model.info.maxTokens) } : {}),
			messages: openAiMessages,
			stream: true,
			stream_options: { include_usage: true },
			...getOpenAIToolParams(tools),
		})

		const toolCallProcessor = new ToolCallProcessor()
		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta
			if (delta?.content) yield { type: "text", text: delta.content }
			if (delta?.tool_calls) yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
			if (chunk.usage) yield* this.yieldUsage(model.info, chunk.usage)
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		if (this.cachedModel) return this.cachedModel

		const id = this.options.huggingFaceModelId || huggingFaceDefaultModelId
		const staticInfo = huggingFaceModels[id as keyof typeof huggingFaceModels]
		this.cachedModel = {
			id,
			info: this.options.huggingFaceModelInfo ?? staticInfo ?? {
				supportsPromptCache: false,
			},
		}
		return this.cachedModel
	}
}
