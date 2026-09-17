// gRPC handler that assembles the Agent Map snapshot from a task's on-disk records
// instead of from the webview's messages. This is the only way to see what the
// message transcript cannot show: a Goal's grandchildren (a child task's own
// subagent runs) and any run whose cards have left the transcript.
//
// Everything on disk here is treated as untrusted and optional. A missing
// directory, a missing sidecar, a half-written goal.json — all of these are the
// ordinary case for some task, so each read fails soft into "no data of that
// kind" and the handler always resolves with a valid snapshot. A rejected RPC
// would leave the overlay with nothing to draw; a root-only snapshot at least
// tells the truth.

import fs from "node:fs/promises"
import * as path from "node:path"
import { ensureTaskDirectoryExists } from "@core/storage/directoryEnsurers"
import { SUBAGENT_RUNS_FILE, readSubagentRunIndex, type SubagentRunRecord } from "@core/task/tools/subagent/SubagentRunIndex"
import type { AgentMapNode, AgentMapNodeStatus, AgentMapSnapshot, AgentMapUsage } from "@shared/agentMap"
import { isTerminalAgentMapStatus } from "@shared/agentMap"
import type { GoalAccounting, GoalChildRole, GoalChildStatus } from "@shared/goal"
import { AgentMapSnapshotResponse } from "@shared/proto/dirac/agent_map"
import type { StringRequest } from "@shared/proto/dirac/common"
import { Logger } from "@shared/services/Logger"
import type { Controller } from "../index"

// Exhaustive maps, not switches with a default: adding a status to either source
// type must break compilation here rather than silently drawing the wrong node.
const SUBAGENT_STATUS_BY_RECORD: Record<SubagentRunRecord["status"], AgentMapNodeStatus> = {
	running: "running",
	completed: "completed",
	failed: "failed",
	cancelled: "cancelled",
}

const GOAL_CHILD_STATUS_BY_RECORD: Record<GoalChildStatus, AgentMapNodeStatus> = {
	starting: "pending",
	running: "running",
	waiting: "waiting",
	completed: "completed",
	failed: "failed",
	cancelled: "cancelled",
	interrupted: "cancelled",
}

// The fields this handler actually needs from goal.json. Narrowing to a local
// minimal shape (rather than casting to GoalRecord) keeps untrusted disk data
// from flowing into the snapshot with fabricated defaults.
interface GoalFileChild {
	id: string
	title: string
	role: GoalChildRole
	status: GoalChildStatus
	createdAt: number
	startedAt?: number
	endedAt?: number
	terminalSummary?: string
}

interface GoalFileRecord {
	createdAt?: number
	objectiveMarkdown: string
	accounting?: GoalAccounting
	children: GoalFileChild[]
}

/**
 * Builds the Agent Map snapshot for a task from its on-disk records: the root
 * node, the task's subagent runs from its runs.json sidecar, and — when the task
 * is a Goal — its child tasks plus each child task's own subagent runs, which the
 * webview cannot derive from the messages it holds. Missing or malformed files
 * are ordinary and contribute "no data of that kind"; the handler always resolves
 * with a valid snapshot.
 * @param _controller The controller instance (unused; the map is derived from disk)
 * @param request The task id to build the map for
 * @returns The snapshot, serialized as JSON in `snapshotJson`
 */
export async function getAgentMap(_controller: Controller, request: StringRequest): Promise<AgentMapSnapshotResponse> {
	const taskId = request.value?.trim() ?? ""
	if (taskId === "") {
		// ensureTaskDirectoryExists would happily create a directory for "" — a junk folder in the
		// user's task store, produced by a caller that had nothing to ask about.
		Logger.warn("[getAgentMap] Called with no task id")
		return AgentMapSnapshotResponse.create({
			snapshotJson: JSON.stringify({ rootTaskId: "", generatedAt: Date.now(), nodes: [] }),
		})
	}
	const taskDir = await ensureTaskDirectoryExists(taskId)

	// The three root-level reads are independent — run them concurrently so the
	// user's click does not pay for three serialised disk round trips.
	const [goal, taskMetadata, rootRuns] = await Promise.all([
		readGoalRecord(taskDir),
		readTaskMetadata(taskDir),
		readSubagentRunIndex(path.join(taskDir, "subagents", SUBAGENT_RUNS_FILE)),
	])

	const subagentNodes = (rootRuns?.runs ?? []).map((run) => subagentNodeFromRecord(run, taskId, "root"))

	// A child's id is itself a task id under the same tasks/ root, so its sidecar
	// lives one directory over. Reading it directly (not via ensureTaskDirectoryExists)
	// keeps a missing child directory from being created as a side effect of drawing.
	const tasksRoot = path.dirname(taskDir)
	const goalChildNodes: AgentMapNode[] = goal
		? (
				await Promise.all(
					goal.children.map(async (child) => {
						const childNode = goalChildNodeFromRecord(child)
						const childRuns = await readSubagentRunIndex(
							path.join(tasksRoot, child.id, "subagents", SUBAGENT_RUNS_FILE),
						)
						// Depth-first per child: each child is immediately followed by its own
						// runs, keeping every parent before its children in a stable order.
						const grandchildNodes = (childRuns?.runs ?? []).map((run) =>
							subagentNodeFromRecord(run, child.id, childNode.id),
						)
						return [childNode, ...grandchildNodes]
					}),
				)
			).flat()
		: []

	const childNodes = [...subagentNodes, ...goalChildNodes]
	const rootNode: AgentMapNode = {
		id: "root",
		parentId: null,
		kind: "root",
		title: goal ? collapseWhitespace(goal.objectiveMarkdown) : taskId,
		status: childNodes.some((node) => !isTerminalAgentMapStatus(node.status)) ? "running" : "completed",
		startedAt: goal?.createdAt,
		usage: goal?.accounting ? usageFromAccounting(goal.accounting) : undefined,
		modelId: firstModelId(taskMetadata),
		transcriptRef: { taskId },
	}

	const snapshot: AgentMapSnapshot = {
		rootTaskId: taskId,
		generatedAt: Date.now(),
		nodes: [rootNode, ...childNodes],
	}
	return AgentMapSnapshotResponse.create({ snapshotJson: JSON.stringify(snapshot) })
}

// --- File readers -----------------------------------------------------------
// Each read is its own helper so one unreadable file can never suppress the
// others: every helper resolves to undefined instead of throwing.

async function readGoalRecord(taskDir: string): Promise<GoalFileRecord | undefined> {
	const parsed = await readOptionalJson(path.join(taskDir, "goal.json"))
	return parsed === undefined ? undefined : asGoalRecord(parsed)
}

async function readTaskMetadata(taskDir: string): Promise<unknown> {
	return readOptionalJson(path.join(taskDir, "task_metadata.json"))
}

async function readOptionalJson(filePath: string): Promise<unknown> {
	let raw: string
	try {
		raw = await fs.readFile(filePath, "utf8")
	} catch (error) {
		// ENOENT is the normal case (no Goal, no metadata); other read failures are
		// still not worth erroring over — the map just omits that data.
		if (!hasErrorCode(error, "ENOENT")) {
			Logger.warn(`[getAgentMap] Failed to read ${filePath}`, error)
		}
		return undefined
	}
	try {
		return JSON.parse(raw) as unknown
	} catch (error) {
		// A half-written file must not take out the whole map — name the file and move on.
		Logger.warn(`[getAgentMap] Malformed JSON in ${filePath}`, error)
		return undefined
	}
}

// --- Narrowing guards -------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asGoalRecord(value: unknown): GoalFileRecord | undefined {
	if (!isRecord(value)) {
		return undefined
	}
	const objective = value.objective
	if (!isRecord(objective) || typeof objective.markdown !== "string") {
		return undefined
	}
	const children = Array.isArray(value.children)
		? value.children.map(asGoalChild).filter((child): child is GoalFileChild => child !== undefined)
		: []
	return {
		createdAt: asTimestamp(value.createdAt),
		objectiveMarkdown: objective.markdown,
		accounting: asAccounting(value.accounting),
		children,
	}
}

function asGoalChild(value: unknown): GoalFileChild | undefined {
	if (!isRecord(value)) {
		return undefined
	}
	if (typeof value.id !== "string" || value.id.length === 0 || typeof value.title !== "string") {
		return undefined
	}
	if (!isGoalChildRole(value.role) || !isGoalChildStatus(value.status)) {
		return undefined
	}
	const createdAt = asTimestamp(value.createdAt)
	if (createdAt === undefined) {
		return undefined
	}
	return {
		id: value.id,
		title: value.title,
		role: value.role,
		status: value.status,
		createdAt,
		startedAt: asTimestamp(value.startedAt),
		endedAt: asTimestamp(value.endedAt),
		terminalSummary: typeof value.terminalSummary === "string" ? value.terminalSummary : undefined,
	}
}

function isGoalChildRole(value: unknown): value is GoalChildRole {
	return value === "task" || value === "verification"
}

function isGoalChildStatus(value: unknown): value is GoalChildStatus {
	return (
		value === "starting" ||
		value === "running" ||
		value === "waiting" ||
		value === "completed" ||
		value === "failed" ||
		value === "cancelled" ||
		value === "interrupted"
	)
}

function isSubagentRunStatus(value: unknown): value is SubagentRunRecord["status"] {
	return value === "running" || value === "completed" || value === "failed" || value === "cancelled"
}

function asAccounting(value: unknown): GoalAccounting | undefined {
	if (!isRecord(value)) {
		return undefined
	}
	return {
		totalTokens: asNonNegativeNumber(value.totalTokens),
		inputTokens: asNonNegativeNumber(value.inputTokens),
		outputTokens: asNonNegativeNumber(value.outputTokens),
		reasoningTokens: asNonNegativeNumber(value.reasoningTokens),
		cacheReadTokens: asNonNegativeNumber(value.cacheReadTokens),
		cacheWriteTokens: asNonNegativeNumber(value.cacheWriteTokens),
		cost: asFiniteNumber(value.cost),
	}
}

function asTimestamp(value: unknown): number | undefined {
	return asNonNegativeNumber(value)
}

function asNonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

// --- Node mapping -----------------------------------------------------------

function subagentNodeFromRecord(run: SubagentRunRecord, taskId: string, parentId: string): AgentMapNode {
	return {
		id: `subagent:${run.runId}`,
		parentId,
		kind: "subagent",
		title: nonEmpty(run.taskTitle) ?? nonEmpty(run.agentName) ?? run.runId,
		// The sidecar's shape check is shallow, so an out-of-union status from disk
		// draws as running rather than crashing the map.
		status: isSubagentRunStatus(run.status) ? SUBAGENT_STATUS_BY_RECORD[run.status] : "running",
		modelId: run.modelId,
		startedAt: run.startedAt,
		endedAt: run.endedAt,
		usage: run.usage,
		prompt: run.prompt,
		transcriptRef: { taskId, runId: run.runId },
	}
}

function goalChildNodeFromRecord(child: GoalFileChild): AgentMapNode {
	return {
		id: `goal-child:${child.id}`,
		parentId: "root",
		kind: child.role === "verification" ? "goal-verification" : "goal-task",
		title: child.title,
		status: GOAL_CHILD_STATUS_BY_RECORD[child.status],
		startedAt: child.startedAt ?? child.createdAt,
		endedAt: child.endedAt,
		prompt: child.terminalSummary,
		transcriptRef: { taskId: child.id },
	}
}

function usageFromAccounting(accounting: GoalAccounting): AgentMapUsage {
	return {
		inputTokens: accounting.inputTokens ?? 0,
		outputTokens: accounting.outputTokens ?? 0,
		cacheReadTokens: accounting.cacheReadTokens ?? 0,
		cacheWriteTokens: accounting.cacheWriteTokens ?? 0,
		totalCost: accounting.cost,
	}
}

function firstModelId(taskMetadata: unknown): string | undefined {
	if (!isRecord(taskMetadata) || !Array.isArray(taskMetadata.model_usage)) {
		return undefined
	}
	for (const entry of taskMetadata.model_usage) {
		if (isRecord(entry) && typeof entry.model_id === "string" && entry.model_id.length > 0) {
			return entry.model_id
		}
	}
	return undefined
}

function nonEmpty(value: string | undefined): string | undefined {
	return value !== undefined && value.trim().length > 0 ? value : undefined
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim()
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code
}
