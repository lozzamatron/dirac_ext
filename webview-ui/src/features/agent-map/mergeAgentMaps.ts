// Combines the map the webview builds from its own messages with the one the extension host reads
// back from disk.
//
// The two sources identify the same subagent run differently — the live map keys a node by the CARD
// that renders it, the disk map by the recorded RUN id — so merging by id would draw every finished
// run twice. Rather than guess a natural key out of titles and timestamps, this merge is deliberate
// about what each source is authoritative for:
//
//   - The live map is authoritative for everything it can see. It is current to the millisecond and
//     its root carries the model and context figures, which the disk records do not.
//   - The disk map is the only source for what the transcript structurally cannot show: a Goal
//     child's OWN subagent runs (depth 2), and any run at all once the messages are gone.
//
// So: grandchildren are always taken from disk, and the disk map is used wholesale only when the
// live map found nothing — which is exactly the "reopened from history, cards are gone" case.
import type { AgentMapNode, AgentMapSnapshot } from "@shared/agentMap"

/**
 * Merges a disk-read snapshot into a live one.
 *
 * @param live - The snapshot built from the messages this webview holds.
 * @param disk - The snapshot the host assembled from the task's records, if any.
 * @returns A snapshot whose root is always the live root.
 */
export function mergeAgentMaps(live: AgentMapSnapshot, disk?: AgentMapSnapshot): AgentMapSnapshot {
	const liveRoot = live.nodes[0]
	if (!disk || disk.nodes.length === 0 || !liveRoot) {
		return live
	}

	const liveChildren = live.nodes.slice(1)
	const diskChildren = disk.nodes.slice(1)

	// Nothing live to preserve: the conversation's cards are gone, so the disk records are all there
	// is. Keep the live ROOT even so — it carries the model and the context size, and the host's root
	// is titled with a task id it had nothing better to use.
	if (liveChildren.length === 0) {
		return {
			...live,
			nodes: [liveRoot, ...diskChildren.map((node) => reparentToLiveRoot(node, liveRoot.id))],
		}
	}

	// Otherwise take only the grandchildren, and only those whose parent is a node the live map
	// actually drew — a node hanging off a parent that is not on screen would render as an orphan.
	const liveIds = new Set(live.nodes.map((node) => node.id))
	const grandchildren = diskChildren.filter(
		(node) =>
			node.parentId !== null &&
			node.parentId !== disk.nodes[0]?.id &&
			liveIds.has(node.parentId) &&
			// An id the live map already uses would render as a duplicate key, not as a second node.
			!liveIds.has(node.id),
	)

	if (grandchildren.length === 0) {
		return live
	}

	return { ...live, nodes: [...live.nodes, ...grandchildren] }
}

/** Re-hangs a disk node that pointed at the host's root id onto the live root's id. */
function reparentToLiveRoot(node: AgentMapNode, liveRootId: string): AgentMapNode {
	if (node.parentId === "root" || node.parentId === null) {
		return { ...node, parentId: liveRootId }
	}
	return node
}
