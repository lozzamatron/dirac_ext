// What each source of an Agent Map is authoritative for. The rules matter more than they look:
// the live map and the disk map identify the same subagent run under different ids (card id vs run
// id), so a merge that trusted ids would draw every finished run twice.
import type { AgentMapNode, AgentMapSnapshot } from "@shared/agentMap"
import { orderAgentMapRows } from "@shared/agentMap"
import { mergeAgentMaps } from "../mergeAgentMaps"

const node = (partial: Partial<AgentMapNode> & Pick<AgentMapNode, "id" | "kind">): AgentMapNode => ({
	parentId: "root",
	title: partial.id,
	status: "completed",
	...partial,
})

const snapshot = (rootTaskId: string, nodes: AgentMapNode[]): AgentMapSnapshot => ({
	rootTaskId,
	generatedAt: 1,
	nodes,
})

const liveRoot = node({ id: "root", kind: "root", parentId: null, title: "Live conversation" })

describe("mergeAgentMaps", () => {
	it("returns the live map untouched when there is no disk map", () => {
		const live = snapshot("t1", [liveRoot, node({ id: "subagent:card-1", kind: "subagent" })])
		expect(mergeAgentMaps(live, undefined)).toBe(live)
	})

	it("returns the live map untouched when the disk map is empty", () => {
		const live = snapshot("t1", [liveRoot, node({ id: "subagent:card-1", kind: "subagent" })])
		expect(mergeAgentMaps(live, snapshot("t1", []))).toBe(live)
	})

	it("does NOT duplicate a run the live map already drew under a different id", () => {
		// The same run: card id on the left, recorded run id on the right.
		const live = snapshot("t1", [liveRoot, node({ id: "subagent:card-1", kind: "subagent", title: "Reply ALPHA" })])
		const disk = snapshot("t1", [
			node({ id: "root", kind: "root", parentId: null, title: "t1" }),
			node({ id: "subagent:run-abc", kind: "subagent", title: "Reply ALPHA" }),
		])
		const merged = mergeAgentMaps(live, disk)
		expect(merged.nodes).toHaveLength(2)
		expect(merged.nodes.map((n) => n.id)).toEqual(["root", "subagent:card-1"])
	})

	it("adds a Goal child's own subagent runs, which the transcript cannot show", () => {
		const live = snapshot("t1", [liveRoot, node({ id: "goal-child:c1", kind: "goal-task", title: "Child One" })])
		const disk = snapshot("t1", [
			node({ id: "root", kind: "root", parentId: null, title: "t1" }),
			node({ id: "goal-child:c1", kind: "goal-task", title: "Child One" }),
			node({ id: "subagent:run-1", kind: "subagent", parentId: "goal-child:c1", title: "Grandchild" }),
		])
		const merged = mergeAgentMaps(live, disk)
		expect(merged.nodes.map((n) => n.id)).toEqual(["root", "goal-child:c1", "subagent:run-1"])
		expect(merged.nodes[2].parentId).toBe("goal-child:c1")
	})

	it("drops a grandchild whose parent is not on screen rather than rendering an orphan", () => {
		const live = snapshot("t1", [liveRoot, node({ id: "goal-child:c1", kind: "goal-task" })])
		const disk = snapshot("t1", [
			node({ id: "root", kind: "root", parentId: null }),
			node({ id: "subagent:run-9", kind: "subagent", parentId: "goal-child:GONE" }),
		])
		expect(mergeAgentMaps(live, disk).nodes).toHaveLength(2)
	})

	it("uses the disk children wholesale when the live map found none, keeping the live root", () => {
		// The "reopened from history, the cards are gone" case.
		const live = snapshot("t1", [liveRoot])
		const disk = snapshot("t1", [
			node({ id: "root", kind: "root", parentId: null, title: "t1" }),
			node({ id: "subagent:run-1", kind: "subagent", title: "From disk" }),
		])
		const merged = mergeAgentMaps(live, disk)
		expect(merged.nodes).toHaveLength(2)
		// The LIVE root survives: it is the one carrying the model and the context size, and the
		// host's root is titled with a task id because it had nothing better.
		expect(merged.nodes[0].title).toBe("Live conversation")
		expect(merged.nodes[1].title).toBe("From disk")
	})

	it("re-hangs disk children onto the live root's id", () => {
		const live = snapshot("t1", [{ ...liveRoot, id: "root" }])
		const disk = snapshot("t1", [
			node({ id: "host-root", kind: "root", parentId: null }),
			node({ id: "subagent:run-1", kind: "subagent", parentId: "root" }),
		])
		const merged = mergeAgentMaps(live, disk)
		expect(merged.nodes[1].parentId).toBe("root")
	})

	it("never replaces the live root", () => {
		const live = snapshot("t1", [liveRoot])
		const disk = snapshot("t1", [node({ id: "root", kind: "root", parentId: null, title: "Disk title" })])
		expect(mergeAgentMaps(live, disk).nodes[0].title).toBe("Live conversation")
	})
})

describe("orderAgentMapRows", () => {
	it("puts a node's own children immediately after it, one level deeper", () => {
		const rows = orderAgentMapRows([
			node({ id: "root", kind: "root", parentId: null }),
			node({ id: "goal-child:c1", kind: "goal-task" }),
			node({ id: "goal-child:c2", kind: "goal-task" }),
			node({ id: "subagent:g1", kind: "subagent", parentId: "goal-child:c1" }),
		])
		expect(rows.map((r) => [r.node.id, r.depth])).toEqual([
			["goal-child:c1", 0],
			["subagent:g1", 1],
			["goal-child:c2", 0],
		])
	})

	it("excludes the root itself", () => {
		const rows = orderAgentMapRows([node({ id: "root", kind: "root", parentId: null })])
		expect(rows).toEqual([])
	})

	it("drops a node whose parent is not in the list rather than drawing it in the wrong place", () => {
		const rows = orderAgentMapRows([
			node({ id: "root", kind: "root", parentId: null }),
			node({ id: "subagent:orphan", kind: "subagent", parentId: "goal-child:GONE" }),
		])
		expect(rows).toEqual([])
	})

	it("terminates on a cycle instead of recursing for ever", () => {
		const rows = orderAgentMapRows([
			node({ id: "root", kind: "root", parentId: null }),
			node({ id: "a", kind: "subagent", parentId: "b" }),
			node({ id: "b", kind: "subagent", parentId: "a" }),
		])
		// Neither is reachable from the root, so neither is drawn — and the walk still returns.
		expect(rows).toEqual([])
	})

	it("returns nothing for an empty node list", () => {
		expect(orderAgentMapRows([])).toEqual([])
	})
})
