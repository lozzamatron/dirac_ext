import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { CardStatus } from "@/shared/ExtensionMessage"
import type { CallGraphNode, CallGraphRequest, CallGraphResult } from "../../../interfaces/CallGraph"
import type { IToolEnvironment } from "../../../interfaces/IToolEnvironment"
import { CallGraphTool } from "../CallGraphTool"

// Distinctive stable fragments lifted verbatim from CallGraphTool.formatResult, so the tests bind
// to the real wording of the two outcomes the tool must never blur:
// - unresolved: the language server could not look at all;
// - resolved-but-empty: the language server looked and found no callers — a finding about the code.
const UNRESOLVED_PHRASE = "could not be resolved by the language server"
const NO_CALLERS_PHRASE = "no callers of"
const EMPTY_FINDING_PHRASE = "This is a finding about the current code, not a lookup failure"

interface FakeCard {
	updateCalls: Array<Record<string, unknown>>
	finalizeCalls: CardStatus[]
}

function node(name: string, depth: number, parentIndex: number, uri: string, line: number): CallGraphNode {
	return { name, detail: "", uri, line, kind: "function", depth, parentIndex }
}

function unresolvedResult(reason: string): CallGraphResult {
	return { resolved: false, unresolvedReason: reason, nodes: [], empty: false }
}

function resolvedResult(nodes: CallGraphNode[]): CallGraphResult {
	return {
		resolved: true,
		unresolvedReason: "",
		nodes,
		// The host computes this; the fake mirrors the contract: the root alone is not a result.
		empty: nodes.length <= 1,
	}
}

function makeEnv(result: CallGraphResult | Error): { env: IToolEnvironment; card: FakeCard; traitCalls: CallGraphRequest[] } {
	const traitCalls: CallGraphRequest[] = []
	const updateCalls: Array<Record<string, unknown>> = []
	const finalizeCalls: CardStatus[] = []
	let mistakeCount = 0

	const card = {
		update: async (patch: Record<string, unknown>) => {
			updateCalls.push(patch)
		},
		finalize: async (status: CardStatus) => {
			finalizeCalls.push(status)
		},
	}

	const env = {
		config: { isSubagentExecution: false },
		ui: {
			upsertText: async () => undefined,
			createCard: async () => card,
		},
		callGraph: {
			get: async (request: CallGraphRequest) => {
				traitCalls.push(request)
				if (result instanceof Error) {
					throw result
				}
				return result
			},
		},
		telemetry: {
			captureCustomMetadata: () => undefined,
		},
		orchestration: {
			getTaskState: (key: string) => (key === "consecutiveMistakeCount" ? mistakeCount : 0),
			setTaskState: (key: string, value: unknown) => {
				if (key === "consecutiveMistakeCount" && typeof value === "number") {
					mistakeCount = value
				}
			},
		},
	}

	return { env: env as unknown as IToolEnvironment, card: { updateCalls, finalizeCalls }, traitCalls }
}

describe("Dirac EXT call_graph tool", () => {
	const tool = new CallGraphTool()

	it("an unresolved result includes the trait's unresolvedReason verbatim", async () => {
		const reason = "No definition of the symbol was found in the current workspace."
		const { env } = makeEnv(unresolvedResult(reason))

		const text = await tool.processCall({ operation: "callers", symbol: "ghostFn" }, env)

		assert.equal(text.includes(`Reason: ${reason}`), true)
		assert.equal(text.includes(UNRESOLVED_PHRASE), true)
	})

	it("an unresolved result never borrows the wording of the no-callers finding", async () => {
		const { env } = makeEnv(unresolvedResult("The language server is still indexing."))

		const text = await tool.processCall({ operation: "callers", symbol: "ghostFn" }, env)

		// If a future reword collapses "I could not look" into "I looked and found nothing", the
		// model would read a lookup failure as evidence the function is dead. Fail loudly here.
		assert.equal(text.includes(NO_CALLERS_PHRASE), false)
		assert.equal(text.includes(EMPTY_FINDING_PHRASE), false)
	})

	it("a resolved result with only the root reports no callers as a finding, not a failure to look", async () => {
		const { env } = makeEnv(resolvedResult([node("purgeCache", 0, -1, "file:///repo/src/cache.ts", 3)]))

		const text = await tool.processCall({ operation: "callers", symbol: "purgeCache" }, env)

		assert.equal(text.includes('Resolved "purgeCache" successfully'), true)
		assert.equal(text.includes(`no callers of "purgeCache"`), true)
		assert.equal(text.includes(EMPTY_FINDING_PHRASE), true)
		assert.equal(text.includes(UNRESOLVED_PHRASE), false)
	})

	it("a resolved result with children renders the tree and neither outcome phrase", async () => {
		const { env } = makeEnv(resolvedResult([
			node("purgeCache", 0, -1, "file:///repo/src/cache.ts", 3),
			node("runCleanup", 1, 0, "file:///repo/src/cleanup.ts", 81),
		]))

		const text = await tool.processCall({ operation: "callers", symbol: "purgeCache" }, env)

		assert.equal(text.includes('Call graph for "purgeCache" (callers), 2 nodes:'), true)
		assert.equal(text.includes(NO_CALLERS_PHRASE), false)
		assert.equal(text.includes(UNRESOLVED_PHRASE), false)
	})

	it("each rendered node line carries the node's name, file path and line number", async () => {
		const { env } = makeEnv(resolvedResult([
			node("purgeCache", 0, -1, "file:///repo/src/cache.ts", 3),
			node("runCleanup", 1, 0, "file:///repo/src/cleanup.ts", 81),
		]))

		const text = await tool.processCall({ operation: "callers", symbol: "purgeCache" }, env)

		assert.equal(text.includes("purgeCache (/repo/src/cache.ts:3)"), true)
		assert.equal(text.includes("runCleanup (/repo/src/cleanup.ts:81)"), true)
	})

	it("nodes are rendered parent-before-child and a child is indented more deeply than its parent", async () => {
		const { env } = makeEnv(resolvedResult([
			node("purgeCache", 0, -1, "file:///repo/src/cache.ts", 3),
			node("runCleanup", 1, 0, "file:///repo/src/cleanup.ts", 81),
			node("flushBuffers", 2, 1, "file:///repo/src/buffers.ts", 12),
		]))

		const text = await tool.processCall({ operation: "callers", symbol: "purgeCache" }, env)

		const lines = text.split("\n")
		const parentLine = lines.find((line) => line.includes("/repo/src/cleanup.ts:81"))
		const childLine = lines.find((line) => line.includes("/repo/src/buffers.ts:12"))
		assert.ok(parentLine, "the parent node line must be rendered")
		assert.ok(childLine, "the child node line must be rendered")
		assert.equal(lines.indexOf(parentLine) < lines.indexOf(childLine), true)
		assert.equal(parentLine.startsWith("  "), true)
		assert.equal(parentLine.startsWith("    "), false)
		assert.equal(childLine.startsWith("    "), true)
	})

	it("the root node — the symbol the question was about — is rendered in the answer", async () => {
		const { env } = makeEnv(resolvedResult([
			node("buildFleetSnapshot", 0, -1, "file:///repo/src/fleet.ts", 42),
			node("collectReadings", 1, 0, "file:///repo/src/readings.ts", 7),
		]))

		const text = await tool.processCall({ operation: "callees", symbol: "buildFleetSnapshot" }, env)

		assert.equal(text.includes("buildFleetSnapshot (/repo/src/fleet.ts:42)"), true)
	})

	it("a missing or blank symbol is rejected with an error string and the trait is never called", async () => {
		const { env, traitCalls } = makeEnv(resolvedResult([]))

		const missing = await tool.processCall({ operation: "callers", symbol: "" }, env)
		const blank = await tool.processCall({ operation: "callers", symbol: "   " }, env)

		assert.equal(missing.includes("`symbol` parameter is required"), true)
		assert.equal(blank.includes("`symbol` parameter is required"), true)
		assert.equal(traitCalls.length, 0)
	})

	it("an unknown operation is rejected the same way and the trait is never called", async () => {
		const { env, traitCalls } = makeEnv(resolvedResult([]))

		const text = await tool.processCall({ operation: "descendants", symbol: "purgeCache" }, env)

		assert.equal(text.includes('must be one of "callers", "callees", or "impact"'), true)
		assert.equal(traitCalls.length, 0)
	})

	it("a rejecting trait resolves to an error string instead of throwing", async () => {
		const { env } = makeEnv(new Error("language server socket closed"))

		let text = ""
		let thrown: unknown
		try {
			text = await tool.processCall({ operation: "impact", symbol: "fragileFn" }, env)
		} catch (error) {
			thrown = error
		}
		assert.equal(thrown, undefined, `processCall threw instead of resolving: ${String(thrown)}`)

		assert.equal(text.includes("The call_graph lookup failed"), true)
		assert.equal(text.includes("language server socket closed"), true)
	})

	it("the card is finalized exactly once with SUCCESS in the success path", async () => {
		const { env, card } = makeEnv(resolvedResult([
			node("purgeCache", 0, -1, "file:///repo/src/cache.ts", 3),
			node("runCleanup", 1, 0, "file:///repo/src/cleanup.ts", 81),
		]))

		await tool.processCall({ operation: "callers", symbol: "purgeCache" }, env)

		assert.equal(card.updateCalls.length, 1)
		assert.equal(card.finalizeCalls.length, 1)
		assert.equal(card.finalizeCalls[0], CardStatus.SUCCESS)
	})
})

