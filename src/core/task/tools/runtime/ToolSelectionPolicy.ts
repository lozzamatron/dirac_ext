import type { DiscoveredTool } from "../discovery/DiscoveredTool";

export type ToolSelectionPolicy =
	| { mode: "delta"; enabledToolIds: readonly string[]; disabledToolIds: readonly string[] }
	| { mode: "exact"; toolIds: readonly string[] }

/** Apply invocation-level selection only to configurable non-task tools. */
export function applyToolSelectionPolicy(
	allTools: readonly DiscoveredTool[],
	configuredEnabledTools: readonly DiscoveredTool[],
	policy?: ToolSelectionPolicy,
): DiscoveredTool[] {
	if (!policy) return [...configuredEnabledTools]

	const selectedIds = new Set(configuredEnabledTools.map((tool) => tool.id))
	const configurableTools = allTools.filter((tool) => tool.exposure.kind === "configurable" && tool.source !== "task")
	const configurableToolIds = new Set(configurableTools.map((tool) => tool.id))

	if (policy.mode === "exact") {
		const exactIds = new Set(policy.toolIds)
		for (const tool of configurableTools) {
			if (exactIds.has(tool.id)) selectedIds.add(tool.id)
			else selectedIds.delete(tool.id)
		}
	} else {
		for (const toolId of policy.enabledToolIds) {
			if (configurableToolIds.has(toolId)) selectedIds.add(toolId)
		}
		for (const toolId of policy.disabledToolIds) {
			if (configurableToolIds.has(toolId)) selectedIds.delete(toolId)
		}
	}

	return allTools.filter((tool) => tool.executable !== false && selectedIds.has(tool.id))
}
