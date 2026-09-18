// Pure layout for the fleet panel: turns a FleetSnapshot into one section per instance with its
// agent tree flattened into grid rows. No React, no RPC, no clock — everything a unit test needs is
// decided here, so the view only draws what this returns.
import type { AgentMapNode } from "@shared/agentMap"
import type { FleetInstance, FleetSnapshot } from "@shared/fleet"

/** One row of a section's rendered tree: a node, its grid row, its depth and its sibling position. */
export interface FleetSectionRow {
	node: AgentMapNode
	/**
	 * 1-based grid row this node's cell STARTS on.
	 *
	 * Not the node's index in this list: a node shares its first row with its first child, so rows
	 * repeat down a branch. That sharing is what lets a card meet the connector that reaches it.
	 */
	row: number
	/** 1 for the root, 2 for a child, 3 for a grandchild. */
	depth: number
	isFirstChild: boolean
	isLastChild: boolean
	/**
	 * How many grid rows this node's cell spans: itself plus every descendant drawn beneath it.
	 *
	 * The walk is depth-first with the parent first, so a node's subtree occupies exactly the rows
	 * from its own down. Spanning them is what lets the card centre against its whole subtree and
	 * meet the connector trunk — without it the card sits in row 1 and the elbow starts a row lower,
	 * joining nothing. Measured in the browser: an 8px gap between the root's bottom and the elbow's
	 * top, which a screenshot shows and no assertion about presence can catch.
	 */
	subtreeSize: number
	/** Whether this node has children drawn beneath it, and so needs a stub out to their trunk. */
	hasChildren: boolean
}

/** One instance's card content: the instance plus its tree laid out for drawing. */
export interface FleetSection {
	instance: FleetInstance
	rows: FleetSectionRow[]
	/** Total agents in this section, EXCLUDING the root. */
	agentCount: number
}

/** Sort rank: the sidebar leads, live tabs follow, detached instances trail. */
const SIDEBAR_RANK = 0
const TAB_RANK = 1
const DETACHED_RANK = 2

/**
 * Lays out the fleet: one section per instance, ordered sidebar → tabs → detached.
 *
 * The order is deliberately STABLE — equal-ranked instances keep the snapshot's order. The snapshot
 * is pushed on every fleet change, so an unstable sort would shuffle cards of equal rank between
 * pushes, and position churn under a live stream is how a user loses the card they were reading:
 * the eye tracks a card by where it sits, not by its instance id.
 *
 * A detached instance sorts last even if it is a tab: it has no visible surface to reveal, so
 * ranking it among live tabs would put a card the user cannot act on in the middle of the ones they
 * can.
 *
 * @param snapshot - The latest fleet snapshot, or `undefined` before the first one arrives.
 * @returns Sections in display order. `undefined` yields `[]`, not a section per nothing.
 */
export function buildFleetSections(snapshot: FleetSnapshot | undefined): FleetSection[] {
	if (!snapshot) {
		return []
	}
	// Pair each instance with its snapshot index up front so the sort can tiebreak on it. (The sort
	// is stable by spec, but the index tiebreak makes that guarantee explicit rather than relying on
	// the engine's sort stability.)
	const ranked = snapshot.instances.map((instance, index) => ({ instance, index }))
	ranked.sort((a, b) => {
		const byRank = rankOf(a.instance) - rankOf(b.instance)
		return byRank !== 0 ? byRank : a.index - b.index
	})
	return ranked.map(({ instance }) => buildSection(instance))
}

/**
 * Sums the agent counts across sections, excluding roots — the panel's "N agents running" figure.
 *
 * @param sections - Sections as returned by {@link buildFleetSections}.
 * @returns The total agent count across the whole fleet.
 */
export function fleetAgentTotal(sections: FleetSection[]): number {
	return sections.reduce((total, section) => total + section.agentCount, 0)
}

function rankOf(instance: FleetInstance): number {
	if (instance.detached) {
		return DETACHED_RANK
	}
	return instance.surface === "sidebar" ? SIDEBAR_RANK : TAB_RANK
}

function buildSection(instance: FleetInstance): FleetSection {
	const nodes = instance.agentMap?.nodes ?? []
	const rows = orderFleetRows(nodes)
	return {
		instance,
		rows,
		// The root is row 1 when present, so every row after it is an agent. An empty tree has no
		// root and no agents.
		agentCount: Math.max(0, rows.length - (rows.length > 0 ? 1 : 0)),
	}
}

/**
 * Flattens a section's nodes parent-before-child, depth-first: the root, then each child, and
 * immediately after each child that child's own children — so a Goal child's subagents sit directly
 * under it rather than in a flat column that would claim them as the root's.
 *
 * Orphans are dropped, never re-parented to the root: drawing an orphan under the root asserts a
 * structure that never ran, and the records these nodes come from are assembled from separate files
 * on the host, so a dangling parent link is a real possibility. This function is pure, so it drops
 * silently — the caller has no better information than it does.
 *
 * @param nodes - The instance's `agentMap.nodes`, in snapshot order.
 * @returns Rows parent-before-child. Empty when there is no root node.
 */
function orderFleetRows(nodes: AgentMapNode[]): FleetSectionRow[] {
	// The root is the node with no parent. If the snapshot carries more than one, the first in
	// snapshot order wins; a second root would draw two trees under one instance card, which is not
	// a structure the model describes.
	const root = nodes.find((node) => node.parentId === null)
	if (!root) {
		return []
	}

	const byId = new Set(nodes.map((node) => node.id))
	const childrenByParent = new Map<string, AgentMapNode[]>()
	for (const node of nodes) {
		// A node whose parent is missing is not reachable from the root and so never enters the walk
		// below: the drop falls out of the traversal rather than needing a special case. Orphans are
		// never re-parented to the root — drawing one there asserts a structure that never ran.
		if (node.parentId === null || !byId.has(node.parentId)) {
			continue
		}
		const siblings = childrenByParent.get(node.parentId)
		if (siblings) {
			siblings.push(node)
		} else {
			childrenByParent.set(node.parentId, [node])
		}
	}

	// Untrusted data crossed a wire to get here: parent links can repeat or cycle. `visited` is
	// claimed on the way DOWN, so each node is laid out at most once and the walk is bounded by the
	// node count — no infinite recursion, and no node drawn twice under two parents.
	const visited = new Set<string>()
	const rows: FleetSectionRow[] = []

	/**
	 * Lays out one node and its subtree, and returns how many rows the subtree consumed.
	 *
	 * A node shares its row with its FIRST child and spans down over the rest — the shape the Agent
	 * Map overlay already draws. The alternative, giving every node a row of its own, cascades the
	 * tree diagonally and leaves each parent's card ending above the elbow that is supposed to reach
	 * it: the connector then joins nothing. That was measured in the browser at an 8px gap, and
	 * again at 4px after a first attempt to patch it.
	 */
	const layout = (node: AgentMapNode, startRow: number, depth: number, isFirstChild: boolean, isLastChild: boolean): number => {
		visited.add(node.id)
		const at = rows.length
		rows.push({ node, row: startRow, depth, isFirstChild, isLastChild, subtreeSize: 1, hasChildren: false })

		const children = (childrenByParent.get(node.id) ?? []).filter((child) => !visited.has(child.id))
		let cursor = startRow
		for (let index = 0; index < children.length; index++) {
			cursor += layout(children[index], cursor, depth + 1, index === 0, index === children.length - 1)
		}

		// A leaf still occupies one row; a parent occupies exactly what its children consumed.
		const consumed = Math.max(1, cursor - startRow)
		rows[at].subtreeSize = consumed
		rows[at].hasChildren = children.length > 0
		return consumed
	}

	layout(root, 1, 1, false, false)
	return rows
}
