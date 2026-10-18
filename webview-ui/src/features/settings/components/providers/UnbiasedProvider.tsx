import { type ModelInfo, unbiasedDefaultModelId, unbiasedModels } from "@shared/api"
import { Mode } from "@shared/ExtensionMessage"
import { EmptyRequest } from "@shared/proto/dirac/common"
import { useEffect, useState } from "react"
import { fromProtobufModelInfo } from "@shared/proto-conversions/models/typeConversion"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { ModelsServiceClient } from "@/shared/api/grpc-client"
import { UnbiasedAccount } from "@/features/unbiased/UnbiasedAccount"
import { ApiKeyField } from "../common/ApiKeyField"
import { ModelInfoView } from "../common/ModelInfoView"
import { ModelSelector } from "../common/ModelSelector"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

interface UnbiasedProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

export function UnbiasedProvider({ showModelOptions, isPopup, currentMode }: UnbiasedProviderProps) {
	const { apiConfiguration, unbiasedWorkloadName, pendingApiConfigurationUpdates } = useSettingsStore()
	const apiKey = apiConfiguration?.unbiasedApiKey
	const isAuthenticated = !!apiKey
	const isKeyPending = Object.hasOwn(pendingApiConfigurationUpdates, "unbiasedApiKey")
	const workloadName = isKeyPending ? undefined : unbiasedWorkloadName
	const { handleFieldChange, handleModeFieldChange } = useApiConfigurationHandlers()
	const [catalog, setCatalog] = useState<{ apiKey: string; models: Record<string, ModelInfo> }>()
	const [isLoadingModels, setIsLoadingModels] = useState(false)
	const [modelsError, setModelsError] = useState<string>()
	const models: Record<string, ModelInfo> =
		catalog && catalog.apiKey === apiKey && !isKeyPending ? catalog.models : unbiasedModels
	const configuredId = currentMode === "plan" ? apiConfiguration?.planModeApiModelId : apiConfiguration?.actModeApiModelId
	const selectedModelId =
		configuredId && (models[configuredId] || configuredId === "pareto" || configuredId.startsWith("pareto-"))
			? configuredId
			: unbiasedDefaultModelId
	const selectedModelInfo: ModelInfo = models[selectedModelId] || { supportsPromptCache: false }

	useEffect(() => {
		setModelsError(undefined)
		if (!apiKey || isKeyPending || !showModelOptions) {
			setCatalog(undefined)
			setIsLoadingModels(false)
			return
		}
		let cancelled = false
		setIsLoadingModels(true)
		ModelsServiceClient.refreshUnbiasedModelsRpc(EmptyRequest.create({})).then(
			(response) => {
				if (cancelled) return
				setCatalog({
					apiKey,
					models: Object.fromEntries(
						Object.entries(response.models).map(([id, info]) => [
							id,
							{
								...fromProtobufModelInfo(info),
								name: info.name,
								supportsTools: info.supportsTools,
							},
						]),
					),
				})
				setIsLoadingModels(false)
			},
			() => {
				if (cancelled) return
				setModelsError("Could not load Unbiased models; showing default metadata.")
				setIsLoadingModels(false)
			},
		)
		return () => {
			cancelled = true
		}
	}, [apiKey, isKeyPending, showModelOptions])
	const isSubscription = isAuthenticated && workloadName != null
	// Hide per-token prices rather than labeling a paid monthly subscription as "Free".
	const modelInfo = isSubscription
		? {
				...selectedModelInfo,
				inputPrice: undefined,
				outputPrice: undefined,
				cacheReadsPrice: undefined,
				cacheWritesPrice: undefined,
			}
		: selectedModelInfo

	return (
		<div className="space-y-3">
			<UnbiasedAccount />
			<ApiKeyField
				helpText="Alternatively, enter an Unbiased API key. Keys are stored locally; remove the key here to sign out locally. Revoke it in the Unbiased dashboard to disable it."
				initialValue={apiConfiguration?.unbiasedApiKey || ""}
				onChange={(value: string) => handleFieldChange("unbiasedApiKey", value)}
				providerName="Unbiased"
				signupUrl="https://platform.unbiased.ai"
			/>
			{showModelOptions && (
				<>
					<ModelSelector
						label="Model"
						key={Object.keys(models).join(",")}
						models={models}
						onChange={(event: any) =>
							handleModeFieldChange(
								{ plan: "planModeApiModelId", act: "actModeApiModelId" },
								event.target.value,
								currentMode,
							)
						}
						selectedModelId={selectedModelId}
					/>
					{isLoadingModels && (
						<p className="text-xs" role="status">
							Loading Unbiased models…
						</p>
					)}
					{modelsError && (
						<p className="text-xs" role="alert">
							{modelsError}
						</p>
					)}
					<ModelInfoView isPopup={isPopup} modelInfo={modelInfo} selectedModelId={selectedModelId} />
					<p className="text-xs">
						{isSubscription
							? "Covered by your Unbiased subscription; plan quotas apply. Dirac records $0 incremental token cost, excluding the monthly fee."
							: "Prices shown are pay-as-you-go estimates for API-key usage."}
					</p>
				</>
			)}
		</div>
	)
}
