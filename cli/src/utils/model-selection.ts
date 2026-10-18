import type { ApiConfiguration, ModelInfo } from "@shared/api"
import { getProviderModelIdKey, getProviderModelInfoKey } from "@shared/storage/provider-keys"
import type { Mode } from "@shared/storage/types"
import type { Controller } from "@/core/controller"
import { getHuggingFaceModels } from "@/core/controller/models/refreshHuggingFaceModels"

/** Build the ID and metadata updates for the mode(s) affected by a CLI model selection. */
export async function createModelSelectionPatch(
	configuration: Pick<ApiConfiguration, "actModeApiProvider" | "planModeApiProvider">,
	selectedMode: Mode,
	modelId: string | undefined,
	separateModels: boolean,
	controller?: Pick<Controller, "readOpenRouterModels">,
): Promise<Record<string, unknown>> {
	const patch: Record<string, unknown> = {}
	const modes: Mode[] = separateModels ? [selectedMode] : ["act", "plan"]
	let huggingFaceModels: Record<string, ModelInfo> | undefined
	let openRouterModels: Record<string, ModelInfo> | undefined

	for (const mode of modes) {
		const provider = mode === "act"
			? configuration.actModeApiProvider
			: configuration.planModeApiProvider || configuration.actModeApiProvider
		if (!provider) continue

		patch[getProviderModelIdKey(provider, mode)] = modelId
		if (provider !== "openrouter" && provider !== "huggingface") continue

		const infoKey = getProviderModelInfoKey(provider, mode)
		if (!infoKey) throw new Error(`Missing model info key for ${provider}`)
		if (!modelId) {
			patch[infoKey] = undefined
			continue
		}
		if (provider === "huggingface") {
			huggingFaceModels ??= await getHuggingFaceModels()
			patch[infoKey] = huggingFaceModels[modelId]
			continue
		}
		openRouterModels ??= await controller?.readOpenRouterModels()
		patch[infoKey] = openRouterModels?.[modelId]
	}

	return patch
}
