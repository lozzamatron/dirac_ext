/**
 * Shared utility for applying provider configuration
 * Used by both AuthView (onboarding) and SettingsPanelContent (settings)
 */

import type { ApiProvider } from "@shared/api"
import {
	getProviderModelIdKey,
	isSecretKey,
	ProviderToApiKeyMap,
	ProviderToBaseUrlKeyMap,
	type SecretKey,
} from "@shared/storage"
import { applyApiConfigurationTransaction } from "@/core/controller/models/apiConfigurationTransaction"
import type { Controller } from "@/core/controller"
import { refreshOpenRouterModels } from "@/core/controller/models/refreshOpenRouterModels"
import { getHuggingFaceModels } from "@/core/controller/models/refreshHuggingFaceModels"
import { refreshVercelAiGatewayModels } from "@/core/controller/models/refreshVercelAiGatewayModels"
import { StateManager } from "@/core/storage/StateManager"
import type { BedrockConfig } from "../components/BedrockSetup"
import { getDefaultModelId, getModelList } from "./model-metadata"

/**
 * Persist only the addressed provider fields and restore those same fields if
 * the durable flush fails. The active Task transition is owned by
 * applyApiConfigurationTransaction and therefore remains unchanged on failure.
 */
async function persistProviderConfigurationWithRollback(
	stateManager: StateManager,
	config: Record<string, unknown>,
): Promise<void> {
	const previousApiConfiguration = structuredClone(stateManager.getApiConfiguration()) as Record<string, unknown>
	const rollbackConfiguration = Object.fromEntries(
		Object.keys(config).map((key) => [
			key,
			isSecretKey(key)
				? stateManager.getSecretKey(key as SecretKey)
				: previousApiConfiguration[key],
		]),
	)

	stateManager.setApiConfiguration(config as Record<string, string>)
	try {
		await stateManager.flushPendingState()
	} catch (error) {
		try {
			stateManager.setApiConfiguration(rollbackConfiguration as Record<string, string>)
			await stateManager.flushPendingState()
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], "Provider configuration persistence and rollback failed")
		}
		throw error
	}
}
export interface ApplyProviderConfigOptions {
	providerId: string
	apiKey?: string
	modelId?: string // Override default model
	baseUrl?: string // For OpenAI-compatible providers
	azureApiVersion?: string // For Azure OpenAI
	controller?: Controller
}

/**
 * Apply provider configuration to state and rebuild API handler if needed
 */
export async function applyProviderConfig(options: ApplyProviderConfigOptions): Promise<void> {
	const { providerId, apiKey, modelId, baseUrl, azureApiVersion, controller } = options
	if (providerId === "unbiased" && modelId && modelId !== "pareto") {
		throw new Error("Unbiased only supports the pareto model")
	}
	const stateManager = StateManager.get()

	const config: Record<string, unknown> = {
		actModeApiProvider: providerId,
		planModeApiProvider: providerId,
	}

	// Add model ID (use provided, existing from state, or fall back to default)
	const actModelKey = getProviderModelIdKey(providerId as ApiProvider, "act")
	const planModelKey = getProviderModelIdKey(providerId as ApiProvider, "plan")

	const existingActModel = stateManager.getGlobalSettingsKey(actModelKey) as string
	const existingPlanModel = stateManager.getGlobalSettingsKey(planModelKey) as string

	const hasSpecificKey = actModelKey !== "actModeApiModelId"
	const validModels = getModelList(providerId)

	const isCompatible = (model: string) => {
		if (!model) return false
		if (hasSpecificKey) return true
		return validModels.includes(model)
	}

	const defaultModel = getDefaultModelId(providerId)

	const finalActModelId =
		modelId ||
		(isCompatible(existingActModel) ? existingActModel : isCompatible(existingPlanModel) ? existingPlanModel : defaultModel)
	const finalPlanModelId =
		modelId ||
		(isCompatible(existingPlanModel) ? existingPlanModel : isCompatible(existingActModel) ? existingActModel : defaultModel)

	if (providerId === "openrouter" && !finalActModelId && !finalPlanModelId) {
		throw new Error("Select an OpenRouter model before configuring the provider")
	}
	if (finalActModelId) {
		if (actModelKey) config[actModelKey] = finalActModelId
	}
	if (finalPlanModelId) {
		if (planModelKey) config[planModelKey] = finalPlanModelId
	}

	if (finalActModelId || finalPlanModelId) {
		// Fetch model info from the provider API (not just disk cache) so headless
		// CLI auth gets correct maxTokens, thinkingConfig, etc.
		if (providerId === "openrouter" && controller) {
			const openRouterModels = await refreshOpenRouterModels(controller)
			if (finalActModelId) {
				const modelInfo = openRouterModels?.[finalActModelId]
				if (modelInfo) {
					config.actModeOpenRouterModelInfo = modelInfo
				}
			}
			if (finalPlanModelId) {
				const modelInfo = openRouterModels?.[finalPlanModelId]
				if (modelInfo) {
					config.planModeOpenRouterModelInfo = modelInfo
				}
			}
		} else if (providerId === "huggingface") {
			const huggingFaceModels = await getHuggingFaceModels()
			config.actModeHuggingFaceModelInfo = huggingFaceModels[finalActModelId]
			config.planModeHuggingFaceModelInfo = huggingFaceModels[finalPlanModelId]
		} else if (providerId === "vercel-ai-gateway" && controller) {
			const vercelModels = await refreshVercelAiGatewayModels(controller)
			if (finalActModelId) {
				const modelInfo = vercelModels?.[finalActModelId]
				if (modelInfo) {
					config.actModeVercelAiGatewayModelInfo = modelInfo
				}
			}
			if (finalPlanModelId) {
				const modelInfo = vercelModels?.[finalPlanModelId]
				if (modelInfo) {
					config.planModeVercelAiGatewayModelInfo = modelInfo
				}
			}
		}
	}

	// Add API key if provided (maps to provider-specific field like anthropicApiKey, openAiApiKey, etc.)
	if (apiKey) {
		const keyField = ProviderToApiKeyMap[providerId as keyof typeof ProviderToApiKeyMap]
		if (keyField) {
			const fields = Array.isArray(keyField) ? keyField : [keyField]
			config[fields[0]] = apiKey
		}
	}

	// Add base URL if provided (for OpenAI-compatible providers)
	if (baseUrl !== undefined) {
		let normalizedBaseUrl = baseUrl.trim()
		if (normalizedBaseUrl) {
			// Normalize URL: strip trailing /chat/completions and trailing slashes
			// The OpenAI SDK appends /chat/completions automatically.
			normalizedBaseUrl = normalizedBaseUrl.replace(/\/chat\/completions\/?$/, "")
			normalizedBaseUrl = normalizedBaseUrl.replace(/\/+$/, "")
		}

		const baseUrlKey = ProviderToBaseUrlKeyMap[providerId as ApiProvider]
		if (baseUrlKey) {
			config[baseUrlKey] = normalizedBaseUrl
		} else {
			// Fallback for generic OpenAI compatible
			config.openAiBaseUrl = normalizedBaseUrl
		}
	}

	// Add Azure API version if provided
	if (azureApiVersion) {
		config.azureApiVersion = azureApiVersion
	}

	const candidateConfiguration = { ...stateManager.getApiConfiguration(), ...config }
	if (controller) {
		await applyApiConfigurationTransaction(
			controller,
			candidateConfiguration,
			async () => persistProviderConfigurationWithRollback(stateManager, config),
			undefined,
			config,
		)
		await controller.postStateToWebview()
	} else {
		stateManager.setApiConfiguration(config as Record<string, string>)
		await stateManager.flushPendingState()
	}
}

export interface ConfigureApiKeyProviderOptions {
	provider: string
	apiKey: string
	modelId?: string
	baseUrl?: string
	azureApiVersion?: string
	controller?: Controller
}

export async function configureApiKeyProvider(options: ConfigureApiKeyProviderOptions): Promise<void> {
	const { getValidCliProviders } = await import("./providers.js")
	const providers = getValidCliProviders()
	const requestedProvider = options.provider.trim()
	const provider = providers.find((candidate) => candidate.toLowerCase() === requestedProvider.toLowerCase())
	if (!provider) throw new Error(`Invalid provider '${options.provider}'. Supported providers: ${providers.join(", ")}`)
	if (provider === "bedrock") {
		throw new Error(
			"Bedrock provider is not supported for quick setup due to complex authentication requirements. Please use interactive setup.",
		)
	}
	if (!ProviderToApiKeyMap[provider as ApiProvider]) throw new Error(`Provider ${provider} does not support API-key setup`)
	if (!options.apiKey.trim()) throw new Error("API key is required")
	if (options.baseUrl && !ProviderToBaseUrlKeyMap[provider as ApiProvider]) {
		throw new Error("Base URL is not supported for this provider")
	}

	const modelId = options.modelId?.trim() || getDefaultModelId(provider)
	if (!modelId) throw new Error("Model ID is required for this provider")
	await applyProviderConfig({
		providerId: provider,
		apiKey: options.apiKey.trim(),
		modelId,
		baseUrl: options.baseUrl,
		azureApiVersion: options.azureApiVersion,
		controller: options.controller,
	})
	StateManager.get().setGlobalState("welcomeViewCompleted", true)
	await StateManager.get().flushPendingState()
}

export interface ApplyBedrockConfigOptions {
	bedrockConfig: BedrockConfig
	modelId?: string
	customModelBaseId?: string // Base model ID for custom ARN/Inference Profile (for capability detection)
	controller?: Controller
}

/**
 * Apply Bedrock provider configuration to state
 * Handles AWS-specific fields (authentication, region, credentials)
 * When customModelBaseId is provided, sets the custom model flags so the system
 * knows to use the ARN as the model ID and the base model for capability detection.
 */
export async function applyBedrockConfig(options: ApplyBedrockConfigOptions): Promise<void> {
	const { bedrockConfig, modelId, customModelBaseId, controller } = options
	const stateManager = StateManager.get()

	const config: Record<string, unknown> = {
		actModeApiProvider: "bedrock",
		planModeApiProvider: "bedrock",
		awsAuthentication: bedrockConfig.awsAuthentication,
		awsRegion: bedrockConfig.awsRegion,
		awsUseCrossRegionInference: bedrockConfig.awsUseCrossRegionInference,
	}

	// Add model ID (use provided, existing from state, or fall back to default)
	const actModelKey = getProviderModelIdKey("bedrock" as ApiProvider, "act")
	const planModelKey = getProviderModelIdKey("bedrock" as ApiProvider, "plan")

	const existingActModel = stateManager.getGlobalSettingsKey(actModelKey) as string
	const existingPlanModel = stateManager.getGlobalSettingsKey(planModelKey) as string

	const validModels = getModelList("bedrock")
	const isCompatible = (model: string) => {
		if (!model) return false
		// For Bedrock, we also consider it compatible if it's an ARN (starts with 'arn:')
		return validModels.includes(model) || model.startsWith("arn:")
	}

	const defaultModel = getDefaultModelId("bedrock")

	const finalActModelId =
		modelId ||
		(isCompatible(existingActModel) ? existingActModel : isCompatible(existingPlanModel) ? existingPlanModel : defaultModel)
	const finalPlanModelId =
		modelId ||
		(isCompatible(existingPlanModel) ? existingPlanModel : isCompatible(existingActModel) ? existingActModel : defaultModel)

	if (finalActModelId) {
		if (actModelKey) config[actModelKey] = finalActModelId
	}
	if (finalPlanModelId) {
		if (planModelKey) config[planModelKey] = finalPlanModelId
	}

	// Handle custom model (Application Inference Profile ARN)
	if (customModelBaseId) {
		config.actModeAwsBedrockCustomSelected = true
		config.planModeAwsBedrockCustomSelected = true
		config.actModeAwsBedrockCustomModelBaseId = customModelBaseId
		config.planModeAwsBedrockCustomModelBaseId = customModelBaseId
	} else {
		// Ensure custom flags are cleared when using a standard model
		config.actModeAwsBedrockCustomSelected = false
		config.planModeAwsBedrockCustomSelected = false
	}

	// Add optional AWS credentials
	if (bedrockConfig.awsProfile !== undefined) config.awsProfile = bedrockConfig.awsProfile
	if (bedrockConfig.awsAccessKey) config.awsAccessKey = bedrockConfig.awsAccessKey
	if (bedrockConfig.awsSecretKey) config.awsSecretKey = bedrockConfig.awsSecretKey
	if (bedrockConfig.awsSessionToken) config.awsSessionToken = bedrockConfig.awsSessionToken

	const candidateConfiguration = { ...stateManager.getApiConfiguration(), ...config }
	if (controller) {
		await applyApiConfigurationTransaction(
			controller,
			candidateConfiguration,
			async () => persistProviderConfigurationWithRollback(stateManager, config),
			undefined,
			config,
		)
		await controller.postStateToWebview()
	} else {
		stateManager.setApiConfiguration(config as Record<string, string>)
		await stateManager.flushPendingState()
	}
}
