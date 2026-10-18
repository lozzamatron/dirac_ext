import type { StateManager } from "@core/storage/StateManager"
import { refreshToolRegistryForWorkspace } from "@core/task/tools/registry/refreshToolRegistry"
import { ToolRegistry } from "@core/task/tools/registry/ToolRegistry"
import type { ExtensionState } from "@shared/ExtensionMessage"

/** Refreshes the tool registry for the workspace and returns the available tools + toggles. */
export async function assembleToolState(
	stateManager: StateManager,
	primaryRootPath: string | undefined,
	ownerTaskId: string | undefined,
): Promise<Pick<ExtensionState, "availableTools" | "toolToggles">> {
	const toolToggles = stateManager.getGlobalSettingsKey("toolToggles") || {}
	await refreshToolRegistryForWorkspace({ workspaceRoot: primaryRootPath, includeUserTools: true, toggles: toolToggles })
	return ToolRegistry.withExclusiveAccess((registry) => {
		const availableTools = registry.getConfigurableTools(ownerTaskId, primaryRootPath).map((tool) => ({
			id: tool.id,
			name: tool.name,
			description: tool.spec.description,
			source: tool.source,
			modulePath: tool.modulePath,
			executable: tool.executable,
		}))
		return { availableTools, toolToggles: registry.getToggles() }
	})
}
