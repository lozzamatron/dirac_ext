// Data model for the Agent Map overlay (WP4): the current task rendered as a root
// node with one child node per subagent run and per Goal child task.
//
// The snapshot is built in the webview from data that already streams there, but the
// shape lives in shared/ so a later extension-host producer (WP5) emits exactly the
// same structure without the view ever knowing the difference. Everything here is
// pure: no store access, no React, no clock reads outside a defaulted parameter.

import type { SubagentTrajectoryEvent } from "./subagents"

export type AgentMapNodeKind = "root" | "subagent" | "goal-task" | "goal-verification" | "handoff"

export type AgentMapNodeStatus = "pending" | "running" | "waiting" | "completed" | "failed" | "cancelled"

export interface AgentMapUsage {
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	totalCost?: number
}

export interface AgentMapNode {
	id: string
	parentId: string | null
	kind: AgentMapNodeKind
	title: string
	status: AgentMapNodeStatus
	modelId?: string
	startedAt?: number
	endedAt?: number
	usage?: AgentMapUsage
	// Root only: how much of the context window the root conversation occupies.
	contextTokens?: number
	// What the agent was asked to do: the subagent prompt, or the Goal child's
	// terminal summary as a stand-in until real prompts are recorded.
	prompt?: string
	trajectory?: SubagentTrajectoryEvent[]
	transcriptRef?: { taskId: string; runId?: string }
}

export interface AgentMapSnapshot {
	rootTaskId: string
	generatedAt: number
	// nodes[0] is always the root; children follow in a stable, source-defined order.
	nodes: AgentMapNode[]
}

export const AGENT_MAP_TERMINAL_STATUSES: readonly AgentMapNodeStatus[] = ["completed", "failed", "cancelled"]

export function isTerminalAgentMapStatus(status: AgentMapNodeStatus): boolean {
	return AGENT_MAP_TERMINAL_STATUSES.includes(status)
}

export function agentMapTotalTokens(usage?: AgentMapUsage): number {
	if (!usage) {
		return 0
	}
	return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

// Compact token formatting shared by the webview overlay and any future host-side
// renderer, so both display identical numbers for the same data.
export function formatAgentMapTokens(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens < 0) {
		return "0"
	}
	if (tokens < 1_000) {
		return String(Math.round(tokens))
	}
	if (tokens < 1_000_000) {
		return compactNumber(tokens, 1_000, "k")
	}
	return compactNumber(tokens, 1_000_000, "M")
}

function compactNumber(tokens: number, divisor: number, suffix: string): string {
	const fixed = (tokens / divisor).toFixed(1)
	const trimmed = fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed
	return `${trimmed}${suffix}`
}

// Human-readable elapsed time. Sub-second durations read as "0s" because the map
// has no use for millisecond precision, and a bare "0m"/"0h" unit is dropped.
export function formatAgentMapDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) {
		return "0s"
	}
	if (ms < 1_000) {
		return "0s"
	}
	if (ms < 60_000) {
		return `${Math.floor(ms / 1_000)}s`
	}
	if (ms < 3_600_000) {
		const minutes = Math.floor(ms / 60_000)
		const seconds = Math.floor((ms % 60_000) / 1_000)
		return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
	}
	const hours = Math.floor(ms / 3_600_000)
	const minutes = Math.floor((ms % 3_600_000) / 60_000)
	return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

// Elapsed time for a node as of `now`: wall time for running nodes, total time for
// finished ones. Undefined when the node never started, so the view can show "—"
// rather than a misleading zero.
export function agentMapNodeDurationMs(node: AgentMapNode, now: number): number | undefined {
	if (node.startedAt === undefined) {
		return undefined
	}
	return Math.max(0, (node.endedAt ?? now) - node.startedAt)
}
