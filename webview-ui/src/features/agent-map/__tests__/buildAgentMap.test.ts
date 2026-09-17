// Tests for buildAgentMap, driven by fixtures captured from REAL Dirac runs (see
// ./fixtures/CAPTURE.md). The subagent fixture is an operation LOG, not a message
// array: it is replayed through the real chat store so card patches (status,
// usage, trajectory) are applied exactly as the live webview applies them.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { type DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"
import type { GoalViewState } from "@shared/goal"
import {
	type AgentMapNode,
	type AgentMapSnapshot,
	agentMapNodeDurationMs,
	agentMapTotalTokens,
	formatAgentMapDuration,
	formatAgentMapTokens,
} from "@shared/agentMap"
import { useChatStore } from "@/features/chat/store/chatStore"
import { buildAgentMap } from "../buildAgentMap"

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures")

// The store refuses a batch whose surfaceId does not match its own, so the reset in
// beforeEach seeds this id and the replay uses it.
const SURFACE_ID = "agent-map-buildAgentMap-test"

// Fixed clocks so no assertion depends on the wall clock.
const SUBAGENT_NOW = 1_789_629_100_000
const GOAL_NOW = 1_789_629_200_000

interface LogOperation {
	type: string
	message?: unknown
	id?: string
	patch?: Record<string, unknown>
	deletions?: string[]
}

type ApplyPresentationBatch = ReturnType<typeof useChatStore.getState>["applyPresentationBatch"]
type PresentationBatchInput = Parameters<ApplyPresentationBatch>[0]

function readOperationLog(fileName: string): LogOperation[] {
	const raw = readFileSync(join(FIXTURES_DIR, fileName), "utf8")
	return raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as LogOperation)
}

// Replays the captured ui_messages.jsonl through the REAL chat store reducer.
// Reading the `create` records alone would leave every subagent stuck at its
// initial status with no usage or trajectory, because those arrive as later
// patch_card operations.
function replaySubagentFixture(): DiracMessage[] {
	const operations = readOperationLog("subagents-1789629085212-ui_messages.jsonl")
	const batch = {
		surfaceId: SURFACE_ID,
		operations,
	} as unknown as PresentationBatchInput
	const result = useChatStore.getState().applyPresentationBatch(batch)
	// A rejected batch would materialise an empty or partial message list and make
	// every downstream assertion vacuously pass, so fail loudly here, naming what
	// the store actually returned. "wrong_surface" is a truthy string, so only an
	// equality check catches a surface-id mismatch.
	expect(
		result,
		`applyPresentationBatch rejected the operation log batch — returned: ${JSON.stringify(result)}`,
	).toBe("applied")
	const messages = useChatStore.getState().diracMessages
	expect(messages.length).toBeGreaterThan(0)
	return messages
}

// The fixture is a full GoalRecord as persisted by the extension host;
// GoalViewState is the view projection of it. The builder only reads
// objective, createdAt, accounting and children, so casting the parsed record
// is honest: every field it touches is present with its real shape.
const goalFixture = JSON.parse(
	readFileSync(join(FIXTURES_DIR, "goal-1789629100438-goal.json"), "utf8"),
) as unknown as GoalViewState

interface SyntheticChildInput {
	id: string
	title: string
	role: "task" | "verification"
	status: string
	createdAt: number
	startedAt?: number
	endedAt?: number
}

function makeGoalState(children: SyntheticChild[]): GoalViewState {
	return {
		objective: { markdown: "synthetic objective", revision: 1, updatedAt: 1_000 },
		createdAt: 1_000,
		accounting: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
		children,
	} as unknown as GoalViewState
}

function subagentNodesOf(snapshot: AgentMapSnapshot): AgentMapNode[] {
	return snapshot.nodes.filter((node) => node.kind === "subagent")
}

function childNodesOf(snapshot: AgentMapSnapshot): AgentMapNode[] {
	return snapshot.nodes.slice(1)
}

// The user's typed prompt is the non-card message whose text mentions the tool
// call; its exact field name is presentation detail, so read it defensively.
function findUserTaskText(messages: DiracMessage[]): string | undefined {
	for (const message of messages) {
		if (message.content.type === DiracMessageType.CARD) {
			continue
		}
		const content = message.content as unknown as { content?: string; text?: string }
		const candidate = content.content ?? content.text
		if (typeof candidate === "string" && candidate.includes("use_subagents")) {
			return candidate
		}
	}
	return undefined
}

describe("buildAgentMap", () => {
	beforeEach(() => {
		// The chat store is a module-level singleton shared with the chatStore suite, and
		// applyPresentationBatch is gated twice: it drops a batch whose surfaceId does not
		// match, and it drops operations whose offset is not exactly presentationOffset + 1.
		// Seed both, or the replay silently produces nothing.
		useChatStore.setState({
			diracMessages: [],
			messageIndexById: new Map(),
			presentationSurfaceId: SURFACE_ID,
			presentationOffset: -1,
			presentationRevision: 0,
			presentationAppends: new Map(),
			visibleMessageIds: [],
			visibleMessageIdSet: new Set(),
		})
	})

	it("replays the captured operation log into a non-empty message list", () => {
		const messages = replaySubagentFixture()
		expect(messages.length).toBeGreaterThan(0)
	})

	it("builds exactly the root plus three subagent nodes, with no nodes for aggregate or usage-summary cards", () => {
		const messages = replaySubagentFixture()
		const taskText = findUserTaskText(messages)
		const snapshot = buildAgentMap({
			rootTaskId: "1789629085212",
			taskText,
			messages,
			now: SUBAGENT_NOW,
		})

		expect(snapshot.nodes).toHaveLength(4)
		for (const node of snapshot.nodes) {
			expect(node.title.includes("Ran 3 subagents")).toBe(false)
			expect(node.title.startsWith("Subagent usage")).toBe(false)
		}
	})

	it("renders the root first, titled with the user's own task text", () => {
		const messages = replaySubagentFixture()
		const taskText = findUserTaskText(messages)
		expect(taskText).toBeDefined()

		const snapshot = buildAgentMap({
			rootTaskId: "1789629085212",
			taskText,
			messages,
			now: SUBAGENT_NOW,
		})

		const root = snapshot.nodes[0]
		expect(root.kind).toBe("root")
		expect(root.parentId).toBeNull()
		expect(root.title.includes("use_subagents")).toBe(true)
		// The builder collapses whitespace, so the title is single-line even if the
		// user's prompt wrapped across lines.
		expect(root.title.includes("\n")).toBe(false)
	})

	it("titles subagent nodes from their task titles, in message order, all parented to the root", () => {
		const messages = replaySubagentFixture()
		const snapshot = buildAgentMap({
			rootTaskId: "1789629085212",
			messages,
			now: SUBAGENT_NOW,
		})

		const subagents = subagentNodesOf(snapshot)
		expect(subagents.map((node) => node.title)).toEqual(["Reply ALPHA", "Reply BETA", "Reply GAMMA"])
		for (const node of subagents) {
			expect(node.parentId).toBe("root")
			expect(node.kind).toBe("subagent")
		}
	})

	it("shows every subagent completed with real timings and usage — proof the log was replayed, not read from create records alone", () => {
		// Status, usage and trajectory all arrive as later patch_card operations in
		// the captured log. A naive reader of the `create` records would see every
		// subagent stuck at its initial status with no usage at all, so these
		// assertions are what distinguish a real replay from a naive parse.
		const messages = replaySubagentFixture()
		const snapshot = buildAgentMap({
			rootTaskId: "1789629085212",
			messages,
			now: SUBAGENT_NOW,
		})

		const subagents = subagentNodesOf(snapshot)
		expect(subagents).toHaveLength(3)
		for (const node of subagents) {
			expect(node.status).toBe("completed")
			expect(node.startedAt).toBeDefined()
			expect(node.endedAt).toBeDefined()
			expect(node.endedAt as number).toBeGreaterThanOrEqual(node.startedAt as number)
			expect(node.usage).toBeDefined()
			expect(agentMapTotalTokens(node.usage)).toBeGreaterThan(0)
		}
	})

	it("carries each subagent's prompt and trajectory", () => {
		const messages = replaySubagentFixture()
		const snapshot = buildAgentMap({
			rootTaskId: "1789629085212",
			messages,
			now: SUBAGENT_NOW,
		})

		for (const node of subagentNodesOf(snapshot)) {
			expect(typeof node.prompt).toBe("string")
			expect(node.prompt?.length).toBeGreaterThan(0)
			expect(Array.isArray(node.trajectory)).toBe(true)
		}
	})

	it("marks the root completed once every subagent has finished", () => {
		const messages = replaySubagentFixture()
		const snapshot = buildAgentMap({
			rootTaskId: "1789629085212",
			messages,
			now: SUBAGENT_NOW,
		})

		expect(snapshot.nodes[0].status).toBe("completed")
	})

	it("produces unique node ids across the snapshot", () => {
		const messages = replaySubagentFixture()
		const snapshot = buildAgentMap({
			rootTaskId: "1789629085212",
			messages,
			now: SUBAGENT_NOW,
		})

		const ids = snapshot.nodes.map((node) => node.id)
		expect(new Set(ids).size).toBe(ids.length)
	})

	it("builds one child node per Goal child, in file order", () => {
		const snapshot = buildAgentMap({
			rootTaskId: "1789629100438",
			messages: [],
			goal: goalFixture,
			now: GOAL_NOW,
		})

		expect(childNodesOf(snapshot).map((node) => node.title)).toEqual([
			"Child One",
			"Child Two",
			"Verify Goal",
		])
	})

	it("maps the verification child to the goal-verification kind and the others to goal-task", () => {
		const snapshot = buildAgentMap({
			rootTaskId: "1789629100438",
			messages: [],
			goal: goalFixture,
			now: GOAL_NOW,
		})

		const children = childNodesOf(snapshot)
		expect(children[0].kind).toBe("goal-task")
		expect(children[1].kind).toBe("goal-task")
		expect(children[2].kind).toBe("goal-verification")
	})

	it("links each Goal child to its own task transcript and invents no per-child usage", () => {
		const snapshot = buildAgentMap({
			rootTaskId: "1789629100438",
			messages: [],
			goal: goalFixture,
			now: GOAL_NOW,
		})

		const children = childNodesOf(snapshot)
		expect(children[0].transcriptRef?.taskId).toBe("1789629101531")
		expect(children[1].transcriptRef?.taskId).toBe("1789629103898")
		expect(children[2].transcriptRef?.taskId).toBe("1789629105848")
		for (const child of children) {
			expect(child.usage).toBeUndefined()
		}
	})

	it("takes the root's usage from the Goal's own accounting", () => {
		const snapshot = buildAgentMap({
			rootTaskId: "1789629100438",
			messages: [],
			goal: goalFixture,
			now: GOAL_NOW,
		})

		const root = snapshot.nodes[0]
		expect(root.usage).toBeDefined()
		expect(agentMapTotalTokens(root.usage)).toBeGreaterThan(0)
		// 26460 is the captured accounting.inputTokens for this Goal run.
		expect(root.usage?.inputTokens).toBe(26460)
	})

	it("falls back to the Goal objective for the root title when no task text is supplied", () => {
		const snapshot = buildAgentMap({
			rootTaskId: "1789629100438",
			messages: [],
			goal: goalFixture,
			now: GOAL_NOW,
		})

		const expected = goalFixture.objective.markdown.replace(/\s+/g, " ").trim()
		expect(snapshot.nodes[0].title).toBe(expected)
	})

	it("marks the root running while a Goal child is still running", () => {
		const goal = makeGoalState([
			{ id: "c1", title: "Child", role: "task", status: "running", createdAt: 1_000, startedAt: 1_100 },
		])
		const snapshot = buildAgentMap({ rootTaskId: "t", messages: [], goal, now: 2_000 })

		expect(snapshot.nodes[0].status).toBe("running")
	})

	it("maps an interrupted Goal child to cancelled", () => {
		const goal = makeGoalState([
			{ id: "c1", title: "Child", role: "task", status: "interrupted", createdAt: 1_000, startedAt: 1_100 },
		])
		const snapshot = buildAgentMap({ rootTaskId: "t", messages: [], goal, now: 2_000 })

		const child = childNodesOf(snapshot)[0]
		expect(child.status).toBe("cancelled")
	})

	it("yields a lone completed root titled Task for empty input", () => {
		const snapshot = buildAgentMap({ rootTaskId: "t", messages: [], now: 1_234 })

		expect(snapshot.nodes).toHaveLength(1)
		const root = snapshot.nodes[0]
		expect(root.kind).toBe("root")
		expect(root.title).toBe("Task")
		expect(root.status).toBe("completed")
	})
})

describe("agent map formatting", () => {
	it("formats token counts compactly and clamps invalid input to zero", () => {
		expect(formatAgentMapTokens(981)).toBe("981")
		expect(formatAgentMapTokens(151_600)).toBe("151.6k")
		expect(formatAgentMapTokens(2_000)).toBe("2k")
		expect(formatAgentMapTokens(1_250_000)).toBe("1.3M")
		expect(formatAgentMapTokens(-5)).toBe("0")
		expect(formatAgentMapTokens(Number.NaN)).toBe("0")
	})

	it("formats durations in coarse human units and clamps invalid input to 0s", () => {
		expect(formatAgentMapDuration(500)).toBe("0s")
		expect(formatAgentMapDuration(36_000)).toBe("36s")
		expect(formatAgentMapDuration(275_000)).toBe("4m 35s")
		expect(formatAgentMapDuration(720_000)).toBe("12m")
		expect(formatAgentMapDuration(3_720_000)).toBe("1h 2m")
		expect(formatAgentMapDuration(7_200_000)).toBe("2h")
		expect(formatAgentMapDuration(-1)).toBe("0s")
	})

	it("computes node durations from startedAt/endedAt, or wall time for running nodes", () => {
		const base: AgentMapNode = {
			id: "n",
			parentId: "root",
			kind: "subagent",
			title: "n",
			status: "running",
		}

		// Never started: the view should show "—", not a misleading zero.
		expect(agentMapNodeDurationMs(base, 5_000)).toBeUndefined()

		// Finished node: total elapsed time.
		expect(agentMapNodeDurationMs({ ...base, startedAt: 1_000, endedAt: 2_500 }, 9_000)).toBe(1_500)

		// Still running: elapsed as of now.
		expect(agentMapNodeDurationMs({ ...base, startedAt: 1_000 }, 4_000)).toBe(3_000)

		// Never negative, even with inconsistent timestamps.
		expect(agentMapNodeDurationMs({ ...base, startedAt: 1_000, endedAt: 500 }, 9_000)).toBe(0)
	})
})

