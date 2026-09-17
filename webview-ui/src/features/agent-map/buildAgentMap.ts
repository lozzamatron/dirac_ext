// Builds an AgentMapSnapshot purely from data the webview already holds: the chat
// message list (for subagent cards) and the optional Goal view state (for Goal
// child tasks). No extension-host round trip, so v1 cannot break core behaviour.
//
// Ordering is deterministic by construction: subagents in message order, Goal
// children in goal.children order, root always first.

import { type Card, type DiracMessage, DiracMessageType, SubagentExecutionStatus } from "@shared/ExtensionMessage"
import type { GoalChildStatus, GoalViewState } from "@shared/goal"
import {
	type AgentMapNode,
	type AgentMapNodeStatus,
	type AgentMapSnapshot,
	type AgentMapUsage,
	isTerminalAgentMapStatus,
} from "@shared/agentMap"
import { readSubagentCardData } from "@shared/subagents"

export interface AgentMapInput {
	rootTaskId: string
	// The human text of the root conversation; preferred over the Goal objective
	// for the root title because it is what the user actually typed.
	taskText?: string
	// The chat store's diracMessages, in order.
	messages: DiracMessage[]
	goal?: GoalViewState
	modelId?: string
	contextTokens?: number
	// Defaults to Date.now(); injected by tests so snapshots are reproducible.
	now?: number
}

// Exhaustive lookups rather than switch-with-default: a new upstream status must
// fail the type check here instead of silently rendering as "completed".
const SUBAGENT_STATUS_MAP: Record<SubagentExecutionStatus, AgentMapNodeStatus> = {
	[SubagentExecutionStatus.PENDING]: "pending",
	[SubagentExecutionStatus.RUNNING]: "running",
	[SubagentExecutionStatus.COMPLETED]: "completed",
	[SubagentExecutionStatus.FAILED]: "failed",
	[SubagentExecutionStatus.CANCELLED]: "cancelled",
}

const GOAL_CHILD_STATUS_MAP: Record<GoalChildStatus, AgentMapNodeStatus> = {
	starting: "pending",
	running: "running",
	waiting: "waiting",
	completed: "completed",
	failed: "failed",
	cancelled: "cancelled",
	interrupted: "cancelled",
}

export function buildAgentMap(input: AgentMapInput): AgentMapSnapshot {
	const now = input.now ?? Date.now()

	const subagentNodes = collectSubagentNodes(input.messages)
	const goalChildNodes = input.goal ? collectGoalChildNodes(input.goal) : []
	const children = [...subagentNodes, ...goalChildNodes]

	// The root is "running" while any child still has work to do; a root with no
	// children counts as completed, since there is nothing left to wait for.
	const hasActiveChild = children.some((node) => !isTerminalAgentMapStatus(node.status))

	const root: AgentMapNode = {
		id: "root",
		parentId: null,
		kind: "root",
		title: resolveRootTitle(input),
		status: hasActiveChild ? "running" : "completed",
		startedAt: resolveRootStartedAt(input),
		transcriptRef: { taskId: input.rootTaskId },
	}
	if (input.modelId !== undefined) {
		root.modelId = input.modelId
	}
	if (input.contextTokens !== undefined) {
		root.contextTokens = input.contextTokens
	}
	if (input.goal) {
		// Only a Goal carries root-level accounting. A task's own totals are not in
		// this input, and an invented zero would render as a real measurement.
		const accounting = input.goal.accounting
		const usage: AgentMapUsage = {
			inputTokens: accounting.inputTokens ?? 0,
			outputTokens: accounting.outputTokens ?? 0,
			cacheReadTokens: accounting.cacheReadTokens ?? 0,
			cacheWriteTokens: accounting.cacheWriteTokens ?? 0,
		}
		if (accounting.cost !== undefined) {
			usage.totalCost = accounting.cost
		}
		root.usage = usage
	}

	return {
		rootTaskId: input.rootTaskId,
		generatedAt: now,
		nodes: [root, ...children],
	}
}

function resolveRootTitle(input: AgentMapInput): string {
	const candidates = [input.taskText, input.goal?.objective.markdown]
	for (const candidate of candidates) {
		const collapsed = candidate?.replace(/\s+/g, " ").trim()
		if (collapsed) {
			return collapsed
		}
	}
	return "Task"
}

function resolveRootStartedAt(input: AgentMapInput): number | undefined {
	if (input.goal) {
		return input.goal.createdAt
	}
	const firstMessage = input.messages[0]
	return firstMessage ? firstMessage.ts : undefined
}

function collectSubagentNodes(messages: DiracMessage[]): AgentMapNode[] {
	// Keyed by card id, which is unique per subagent run. Map.set on an existing
	// key replaces the value but keeps the original insertion position, giving the
	// required "last one wins, keep position" behaviour for duplicate card ids.
	const nodesByCardId = new Map<string, AgentMapNode>()
	for (const message of messages) {
		if (message.content.type !== DiracMessageType.CARD) {
			continue
		}
		const card = message.content.card
		// Returns undefined for every non-subagent card, including the aggregate
		// "Ran N subagents" card and the per-subagent usage summary cards. That is
		// the only filter needed; do not additionally match on toolName.
		const data = readSubagentCardData(card)
		if (!data) {
			continue
		}
		nodesByCardId.set(`subagent:${card.id}`, toSubagentNode(card, data))
	}
	return Array.from(nodesByCardId.values())
}

function toSubagentNode(card: Card, data: NonNullable<ReturnType<typeof readSubagentCardData>>): AgentMapNode {
	const node: AgentMapNode = {
		id: `subagent:${card.id}`,
		parentId: "root",
		kind: "subagent",
		title: data.taskTitle && data.taskTitle.trim().length > 0 ? data.taskTitle : data.name,
		status: SUBAGENT_STATUS_MAP[data.status],
		startedAt: card.startTime,
		endedAt: card.endTime,
		prompt: data.prompt,
		trajectory: data.trajectory,
		// No transcriptRef: a subagent run has no task directory of its own in v1.
	}
	if (data.usage) {
		node.usage = {
			inputTokens: data.usage.inputTokens,
			outputTokens: data.usage.outputTokens,
			cacheReadTokens: data.usage.cacheReadTokens,
			cacheWriteTokens: data.usage.cacheWriteTokens,
			totalCost: data.usage.totalCost,
		}
	}
	return node
}

function collectGoalChildNodes(goal: GoalViewState): AgentMapNode[] {
	return goal.children.map((child) => {
		const node: AgentMapNode = {
			id: `goal-child:${child.id}`,
			parentId: "root",
			kind: child.role === "verification" ? "goal-verification" : "goal-task",
			title: child.title,
			status: GOAL_CHILD_STATUS_MAP[child.status],
			startedAt: child.startedAt ?? child.createdAt,
			endedAt: child.endedAt,
			transcriptRef: { taskId: child.id },
		}
		if (child.terminalSummary) {
			// The terminal summary stands in for the child's prompt until real
			// prompts are recorded per child.
			node.prompt = child.terminalSummary
		}
		// No usage: per-child accounting is not in GoalTaskSummary, and a zero
		// would read as "this child used no tokens" rather than "not measured
		// here". WP5 adds it.
		return node
	})
}
