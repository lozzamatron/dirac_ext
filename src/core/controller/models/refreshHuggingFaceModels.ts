import { huggingFaceModels, type ModelInfo } from "@shared/api"
import { EmptyRequest } from "@shared/proto/dirac/common"
import { OpenRouterCompatibleModelInfo, OpenRouterModelInfo } from "@shared/proto/dirac/models"
import { fileExistsAtPath } from "@utils/fs"
import axios from "axios"
import fs from "fs/promises"
import path from "path"
import { ensureCacheDirectoryExists } from "@/core/storage/disk"
import { getAxiosSettings } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."

interface RouterProvider {
	provider: string
	status: string
	context_length?: number
	supports_tools?: boolean
}

interface RouterModel {
	id: string
	architecture?: { input_modalities?: string[] }
	providers?: RouterProvider[]
}

/** Convert the router catalog to the subset of models Dirac can use as an agent. */
export function parseHuggingFaceRouterModels(rawModels: RouterModel[]): Record<string, ModelInfo> {
	const models: Record<string, ModelInfo> = {}
	for (const rawModel of rawModels) {
		const providers = rawModel.providers?.filter((provider) => provider.status === "live" && provider.supports_tools) ?? []
		if (!providers.length) continue

		const contextLengths = providers
			.map((provider) => provider.context_length)
			.filter((length): length is number => length !== undefined)
		const contextWindow = contextLengths.length ? Math.min(...contextLengths) : undefined
		models[rawModel.id] = {
			// Context length includes input; reserve most of it for prompts and tool responses.
			maxTokens: contextWindow ? Math.min(8192, Math.floor(contextWindow / 4)) : undefined,
			contextWindow,
			supportsImages: rawModel.architecture?.input_modalities?.includes("image") ?? false,
			supportsPromptCache: false,
			supportsTools: true,
			// HF routes through different providers at different prices: a single rate would be misleading.
			description: `Tool-capable providers: ${providers.map((provider) => provider.provider).join(", ")}`,
		}
	}
	return models
}

/** Return chat models with a live tool-capable route; Dirac needs tool calling to operate. */
export async function getHuggingFaceModels(): Promise<Record<string, ModelInfo>> {
	const huggingFaceModelsFilePath = path.join(await ensureCacheDirectoryExists(), "huggingface_models_v3.json")
	let models: Record<string, ModelInfo> = {}

	try {
		const response = await axios.get<{ data: RouterModel[] }>("https://router.huggingface.co/v1/models", {
			timeout: 10000,
			...getAxiosSettings(),
		})
		models = parseHuggingFaceRouterModels(response.data.data)
		if (!Object.keys(models).length) throw new Error("Hugging Face returned no tool-capable models")
		await fs.writeFile(huggingFaceModelsFilePath, JSON.stringify(models, null, 2))
	} catch (error) {
		Logger.error("Error fetching Hugging Face models:", error)
		if (await fileExistsAtPath(huggingFaceModelsFilePath)) {
			models = JSON.parse(await fs.readFile(huggingFaceModelsFilePath, "utf-8"))
		} else {
			models = Object.fromEntries(
				Object.entries(huggingFaceModels)
					.filter(([, info]) => info.supportsTools)
					.map(([id, info]) => [
						id,
						{
							maxTokens: Math.min(8192, info.maxTokens ?? 8192),
							contextWindow: info.contextWindow,
							supportsImages: info.supportsImages,
							supportsPromptCache: false,
							supportsTools: true,
							description: info.description,
						},
					]),
			)
		}
	}
	return models
}

/** Refreshes and returns Hugging Face models for the VS Code RPC. */
export async function refreshHuggingFaceModels(
	_controller: Controller,
	_request: EmptyRequest,
): Promise<OpenRouterCompatibleModelInfo> {
	const models = await getHuggingFaceModels()
	return OpenRouterCompatibleModelInfo.create({
		models: Object.fromEntries(
			Object.entries(models).map(([id, info]) => [
				id,
				OpenRouterModelInfo.create({
					maxTokens: info.maxTokens,
					contextWindow: info.contextWindow,
					supportsImages: info.supportsImages,
					supportsPromptCache: info.supportsPromptCache,
					supportsTools: info.supportsTools,
					description: info.description,
				}),
			]),
		),
	})
}
