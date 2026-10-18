import { theme } from "../constants/theme"
/**
 * Model picker component for model selection
 * Supports static model lists and dynamic provider catalogs
 */

import { Box, Text } from "ink"
import Spinner from "ink-spinner"
import React, { useEffect, useMemo, useState } from "react"
import { refreshOpenRouterModels } from "@/core/controller/models/refreshOpenRouterModels"
import { refreshGithubCopilotModels } from "@/core/controller/models/refreshGithubCopilotModels"
import { getHuggingFaceModels } from "@/core/controller/models/refreshHuggingFaceModels"
import { type ApiProvider } from "@/shared/api"
import { filterOpenRouterModelIds } from "@/shared/utils/model-filters"
import { COLORS } from "../constants/colors"
import { Logger } from "@/shared/services/Logger"
import { getDefaultModelId, getModelList, hasModelPicker, hasStaticModels, providerModels } from "../utils/model-metadata"
import { usesOpenRouterModels } from "../utils/openrouter-models"
import { SearchableList, SearchableListItem } from "./SearchableList"

// Special ID used to indicate the user wants to enter a custom model ID / ARN
export const CUSTOM_MODEL_ID = "__custom__"

export { getDefaultModelId, getModelList, hasModelPicker, hasStaticModels, providerModels }

interface ModelPickerProps {
	provider: string
	controller: any
	onChange: (modelId: string) => void
	onSubmit: (modelId: string) => void
	isActive?: boolean
}

export const ModelPicker: React.FC<ModelPickerProps> = ({ provider, controller, onChange, onSubmit, isActive = true }) => {
	const [isLoading, setIsLoading] = useState(false)
	const [asyncModels, setAsyncModels] = useState<string[]>([])
	const [loadError, setLoadError] = useState<string | null>(null)

	// Fetch dynamic models when needed
	useEffect(() => {
		const loadsOpenRouterModels = usesOpenRouterModels(provider)
		const loadsGithubModels = provider === "github-copilot"
		const loadsHuggingFaceModels = provider === "huggingface"
		if (!loadsOpenRouterModels && !loadsGithubModels && !loadsHuggingFaceModels) {
			setAsyncModels([])
			setLoadError(null)
			setIsLoading(false)
			return
		}

		let cancelled = false
		setAsyncModels([])
		setLoadError(null)
		setIsLoading(true)

		const loadModels = loadsOpenRouterModels
			? refreshOpenRouterModels(controller)
			: loadsHuggingFaceModels
				? getHuggingFaceModels()
				: refreshGithubCopilotModels()
		loadModels.then(
			(models) => {
				if (cancelled) return
				const modelIds = Object.keys(models).sort((a, b) => a.localeCompare(b))
				if (modelIds.length === 0) {
					setLoadError("The provider returned no models.")
				}
				setAsyncModels(
					loadsOpenRouterModels ? filterOpenRouterModelIds(modelIds, provider as ApiProvider) : modelIds,
				)
				setIsLoading(false)
			},
			(error) => {
				Logger.error(`Failed to load models for ${provider}:`, error)
				if (cancelled) return
				setLoadError(error instanceof Error ? error.message : String(error))
				setIsLoading(false)
			},
		)

		return () => {
			cancelled = true
		}
	}, [provider, controller])

	const modelList = useMemo(() => {
		if (provider === "huggingface") return asyncModels.length ? asyncModels : getModelList(provider)
		if (usesOpenRouterModels(provider) || provider === "github-copilot") return asyncModels
		return getModelList(provider)
	}, [provider, asyncModels])

	// Providers that support custom model IDs (e.g., Bedrock Application Inference Profiles)
	const supportsCustomModel = provider === "bedrock" || usesOpenRouterModels(provider)

	const items: SearchableListItem[] = useMemo(() => {
		const list = modelList.map((modelId) => ({
			id: modelId,
			label: modelId,
		}))
		// Add "Custom" option at the end for providers that support it
		if (supportsCustomModel) {
			const label = usesOpenRouterModels(provider) ? "Custom Model ID / Preset" : "Custom (ARN / Inference Profile)"
			list.push({
				id: CUSTOM_MODEL_ID,
				label,
			})
		}
		return list
	}, [modelList, supportsCustomModel, provider])

	// For providers without a model picker, render nothing
	if (!hasModelPicker(provider)) {
		return null
	}

	// Show loading state for async providers
	if (isLoading) {
		return (
			<Box>
				<Text color={COLORS.primaryBlue}>
					<Spinner type="dots" />
				</Text>
				<Text color={theme.muted}> Loading models...</Text>
			</Box>
		)
	}

	if (loadError && !supportsCustomModel && provider !== "huggingface") {
		return <Text color={theme.error}>Could not load models: {loadError}</Text>
	}

	return (
		<Box flexDirection="column">
			{loadError && (
				<Text color={theme.warning}>
					{provider === "huggingface"
						? "Model list unavailable; showing fallback models."
						: "Model list unavailable; enter a custom model ID."}
				</Text>
			)}
			<SearchableList
				isActive={isActive}
				items={items}
				onSelect={(item) => {
					onChange(item.id)
					onSubmit(item.id)
				}}
			/>
		</Box>
	)
}
