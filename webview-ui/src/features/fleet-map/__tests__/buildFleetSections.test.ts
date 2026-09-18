// Layout tests for the fleet panel: what buildFleetSections promises about ordering, tree shape and
// counting, asserted against concrete fixtures so a regression fails with the wrong ids in view.
import type { AgentMapNode, AgentMapSnapshot } from "@shared/agentMap"
import type { FleetInstance, FleetSnapshot } from "@shared/fleet"
import { buildFleetSections, fleetAgentTotal } from "../buildFleetSections"

const node = (partial: Partial<AgentMapNode> & Pick<AgentMapNode, "id" | "kind">): AgentMapNode => ({
	parentId: "root",
	title: partial.id,
	status: "completed",
	...partial,
})

const root = node({ id: "root", kind: "root", parentId: null, title: "Task" })

const map = (nodes: AgentMapNode[]): AgentMapSnapshot => ({
	rootTaskId: "t1",
	generatedAt: 1,
	nodes,
})

const instance = (partial: Partial<FleetInstance> & Pick<FleetInstance, "instanceId">): FleetInstance => ({
	surface: "tab",
	title: partial.instanceId,
	detached: false,
	visible: true,
	status: "idle",
	...partial,
})

const snapshot = (instances: FleetInstance[]): FleetSnapshot => ({
	generatedAt: 1,
	instances,
})

/** The common shape of the tree fixtures: one instance carrying the given agent map. */
const instanceWithMap = (nodes: AgentMapNode[]): FleetInstance =>
	instance({ instanceId: "i1", agentMap: map(nodes) })

describe("buildFleetSections", () => {
	it("yields nothing before the first snapshot arrives", () => {
		expect(buildFleetSections(undefined)).toEqual([])
	})

	it("yields nothing for a snapshot with no instances", () => {
		expect(buildFleetSections(snapshot([]))).toEqual([])
	})

	it("puts the sidebar first even when the snapshot lists it last", () => {
		const sections = buildFleetSections(snapshot([
			instance({ instanceId: "tab-1" }),
			instance({ instanceId: "tab-2" }),
			instance({ instanceId: "side-1", surface: "sidebar" }),
		]))
		expect(sections.map((s) => s.instance.instanceId)).toEqual(["side-1", "tab-1", "tab-2"])
	})

	it("keeps tabs in the snapshot's own order among themselves", () => {
		const sections = buildFleetSections(snapshot([
			instance({ instanceId: "tab-b" }),
			instance({ instanceId: "side-1", surface: "sidebar" }),
			instance({ instanceId: "tab-a" }),
		]))
		expect(sections.map((s) => s.instance.instanceId)).toEqual(["side-1", "tab-b", "tab-a"])
	})

	it("sorts a detached tab behind the live tabs even though it is a tab", () => {
		const sections = buildFleetSections(snapshot([
			instance({ instanceId: "detached-1", detached: true }),
			instance({ instanceId: "tab-1" }),
			instance({ instanceId: "tab-2" }),
		]))
		expect(sections.map((s) => s.instance.instanceId)).toEqual(["tab-1", "tab-2", "detached-1"])
	})

	it("sorts a detached sidebar last too — detachment outranks surface", () => {
		const sections = buildFleetSections(snapshot([
			instance({ instanceId: "detached-side", surface: "sidebar", detached: true }),
			instance({ instanceId: "side-1", surface: "sidebar" }),
			instance({ instanceId: "tab-1" }),
		]))
		expect(sections.map((s) => s.instance.instanceId)).toEqual(["side-1", "tab-1", "detached-side"])
	})

	it("keeps equal-ranked instances in snapshot order, so cards do not shuffle between pushes", () => {
		const sections = buildFleetSections(snapshot([
			instance({ instanceId: "tab-1" }),
			instance({ instanceId: "tab-2" }),
			instance({ instanceId: "tab-3" }),
		]))
		expect(sections.map((s) => s.instance.instanceId)).toEqual(["tab-1", "tab-2", "tab-3"])
	})

	it("draws a root-only map as one row at depth 1 with no sibling flags", () => {
		const [section] = buildFleetSections(snapshot([instanceWithMap([root])]))
		expect(section?.rows).toEqual([
			{ node: root, row: 1, depth: 1, isFirstChild: false, isLastChild: false, subtreeSize: 1, hasChildren: false },
		])
	})

	// The span is what lets a card centre against its own subtree and meet the connector trunk. A
	// card that spans only its own row leaves a gap the elbow cannot cross, so it joins nothing —
	// found by measuring the rendered grid, not by looking at it.
	it("spans a childless root over one row and gives it no stub", () => {
		const [section] = buildFleetSections(snapshot([instanceWithMap([root])]))
		expect(section?.rows.map((r) => [r.subtreeSize, r.hasChildren])).toEqual([[1, false]])
	})

	it("spans the root over its whole subtree, and each parent over its own", () => {
		// root -> (a -> a1, a2), b : five rows, and two of them are parents.
		const [section] = buildFleetSections(
			snapshot([
				instanceWithMap([
					root,
					node({ id: "a", kind: "goal-task" }),
					node({ id: "a1", kind: "subagent", parentId: "a" }),
					node({ id: "a2", kind: "subagent", parentId: "a" }),
					node({ id: "b", kind: "subagent" }),
				]),
			]),
		)
		expect(section?.rows.map((r) => r.node.id)).toEqual(["root", "a", "a1", "a2", "b"])
		// Three rows in total: a1 and a2 stack, then b below them. The root and `a` each span what
		// their own children consumed, not the whole node count.
		expect(section?.rows.map((r) => r.row)).toEqual([1, 1, 1, 2, 3])
		expect(section?.rows.map((r) => r.subtreeSize)).toEqual([3, 2, 1, 1, 1])
		expect(section?.rows.map((r) => r.hasChildren)).toEqual([true, true, false, false, false])
	})

	// A node SHARES its first row with its first child — the shape the Agent Map overlay draws — so
	// rows repeat down a branch rather than counting up once per node. Laying every node on its own
	// row cascades the tree diagonally and leaves each parent's card ending above the elbow meant to
	// reach it; that was measured in the browser twice before this contract was written down.
	it("puts the root on the same row as its first child, and later siblings below", () => {
		const [section] = buildFleetSections(snapshot([instanceWithMap([
			root,
			node({ id: "c1", kind: "subagent", title: "First" }),
			node({ id: "c2", kind: "subagent", title: "Second" }),
		])]))
		expect(section?.rows.map((r) => [r.node.id, r.row, r.depth])).toEqual([
			["root", 1, 1],
			["c1", 1, 2],
			["c2", 2, 2],
		])
	})

	it("draws a Goal child's own children immediately after it, one level deeper", () => {
		const [section] = buildFleetSections(snapshot([instanceWithMap([
			root,
			node({ id: "c1", kind: "goal-task", title: "Child One" }),
			node({ id: "g1", kind: "subagent", parentId: "c1", title: "Grandchild" }),
			node({ id: "c2", kind: "goal-task", title: "Child Two" }),
		])]))
		expect(section?.rows.map((r) => [r.node.id, r.depth])).toEqual([
			["root", 1],
			["c1", 2],
			["g1", 3],
			["c2", 2],
		])
	})

	it("reads the sibling flags against the node's own sibling group, not the flat row list", () => {
		const [section] = buildFleetSections(snapshot([instanceWithMap([
			root,
			node({ id: "c1", kind: "goal-task" }),
			node({ id: "g1a", kind: "subagent", parentId: "c1" }),
			node({ id: "g1b", kind: "subagent", parentId: "c1" }),
			node({ id: "c2", kind: "goal-task" }),
			node({ id: "g2a", kind: "subagent", parentId: "c2" }),
			node({ id: "g2b", kind: "subagent", parentId: "c2" }),
		])]))
		expect(section?.rows.map((r) => [r.node.id, r.isFirstChild, r.isLastChild])).toEqual([
			["root", false, false],
			["c1", true, false],
			["g1a", true, false],
			["g1b", false, true],
			["c2", false, true],
			["g2a", true, false],
			["g2b", false, true],
		])
	})

	it("drops a node whose parent is not in the map rather than re-parenting it to the root", () => {
		const [section] = buildFleetSections(snapshot([instanceWithMap([
			root,
			node({ id: "c1", kind: "subagent" }),
			node({ id: "orphan", kind: "subagent", parentId: "GONE" }),
		])]))
		expect(section?.rows.map((r) => r.node.id)).toEqual(["root", "c1"])
	})

	it("terminates on a cycle and draws each node at most once", () => {
		// The last node re-uses the root's id with a parent link back into the tree: root → a → b →
		// "root". The visited set is what stops the walk from drawing the root a second time.
		const [section] = buildFleetSections(snapshot([instanceWithMap([
			root,
			node({ id: "a", kind: "subagent" }),
			node({ id: "b", kind: "subagent", parentId: "a" }),
			node({ id: "root", kind: "subagent", parentId: "b" }),
		])]))
		expect(section?.rows.map((r) => r.node.id)).toEqual(["root", "a", "b"])
	})

	it("yields no rows at all when no node claims parentId null", () => {
		const [section] = buildFleetSections(snapshot([instanceWithMap([
			node({ id: "x", kind: "subagent" }),
			node({ id: "y", kind: "subagent", parentId: "x" }),
		])]))
		expect(section?.rows).toEqual([])
	})

	it("yields no rows and no agents for an instance with no agent map", () => {
		const [section] = buildFleetSections(snapshot([instance({ instanceId: "i1" })]))
		expect(section?.rows).toEqual([])
		expect(section?.agentCount).toBe(0)
	})

	it("counts a root plus two children as two agents — the root is not its own agent", () => {
		const [section] = buildFleetSections(snapshot([instanceWithMap([
			root,
			node({ id: "c1", kind: "subagent" }),
			node({ id: "c2", kind: "subagent" }),
		])]))
		expect(section?.agentCount).toBe(2)
	})

	it("counts grandchildren as agents too", () => {
		const [section] = buildFleetSections(snapshot([instanceWithMap([
			root,
			node({ id: "c1", kind: "goal-task" }),
			node({ id: "g1", kind: "subagent", parentId: "c1" }),
		])]))
		expect(section?.agentCount).toBe(2)
	})
})

describe("fleetAgentTotal", () => {
	it("sums the agent counts across sections", () => {
		const sections = buildFleetSections(snapshot([
			instance({ instanceId: "i1", agentMap: map([root, node({ id: "c1", kind: "subagent" })]) }),
			instance({
				instanceId: "i2",
				agentMap: map([root, node({ id: "c1", kind: "subagent" }), node({ id: "c2", kind: "subagent" })]),
			}),
		]))
		expect(fleetAgentTotal(sections)).toBe(3)
	})

	it("totals zero for an empty section list", () => {
		expect(fleetAgentTotal([])).toBe(0)
	})
})
