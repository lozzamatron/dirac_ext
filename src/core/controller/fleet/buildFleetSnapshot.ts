// Assembles the Fleet Map snapshot (WP5b): every live Dirac EXT webview instance
// — the sidebar, every editor tab, every detached background task — as one card
// per instance, with that instance's agent tree beneath it.
//
// This module only BUILDS, once, when asked. The push cadence — the subscriber
// attach, the registry change emitter, the state-publication hook, the 5s safety
// interval and the trailing throttle — lives in the `subscribeToFleet` transport,
// not here; keeping the two apart is what makes this function testable and the
// throttle the single place that decides how often the disk is read.

import { buildAgentMapSnapshot } from "@core/controller/agentMap/buildAgentMapSnapshot"
import { webviewInstances } from "@core/webview/InstanceRegistry"
import { DEFAULT_WEBVIEW_TITLE } from "@core/webview/taskTitle"
import type { AgentMapSnapshot } from "@shared/agentMap"
import type { FleetInstance, FleetInstanceSurface, FleetSnapshot } from "@shared/fleet"
import { FLEET_STATUS_BY_TASK_STATUS } from "@shared/fleet"
import { Logger } from "@/shared/services/Logger"

/**
 * Narrows a webview surface to the surfaces a fleet card can describe.
 *
 * `nonFleet()` guarantees the instance is never a fleet panel, but the TYPES do
 * not know that — and a cast here would put the fleet panel in its own map the
 * day someone changes `nonFleet()`. Returning `undefined` for `"fleet"` and
 * skipping the instance instead means the failure mode is a missing card, not the
 * map showing the map.
 */
function fleetSurfaceOf(surface: "sidebar" | "tab" | "fleet"): FleetInstanceSurface | undefined {
	return surface === "fleet" ? undefined : surface
}

/**
 * Builds the whole fleet snapshot from the instance registry.
 *
 * Iterates `webviewInstances.nonFleet()` — a fleet panel must never appear in its
 * own listing — and builds each instance's agent map from its on-disk records via
 * the same {@link buildAgentMapSnapshot} the per-task overlay uses, so the fleet
 * map cannot quietly disagree with the overlay about the same conversation.
 *
 * The per-instance maps are built concurrently, not in a serial loop: each one
 * does several disk reads, and this runs on a throttle while the user watches.
 * One instance whose map fails must not take out the whole snapshot — a fleet
 * with one card missing its tree is still a true fleet, whereas a rejected
 * rebuild leaves the panel frozen on stale data with no way to tell.
 * @returns The snapshot, instances in the registry's insertion order
 */
export async function buildFleetSnapshot(): Promise<FleetSnapshot> {
	const cards = await Promise.all(
		webviewInstances.nonFleet().map(async (instance): Promise<FleetInstance | undefined> => {
			const surface = fleetSurfaceOf(instance.surface)
			if (!surface) {
				// Not expected — `nonFleet()` filters fleet panels — but skipping beats casting:
				// see `fleetSurfaceOf`.
				Logger.warn("[buildFleetSnapshot] skipping a fleet-panel instance that reached the non-fleet listing")
				return undefined
			}

			const task = instance.controller.task
			const taskId = task?.taskId

			let agentMap: AgentMapSnapshot | undefined
			if (taskId) {
				try {
					agentMap = await buildAgentMapSnapshot(taskId)
				} catch (error) {
					// The builder is written to fail soft, so a rejection here is a real bug — but
					// the fleet must still resolve: one card without its tree, named in the log,
					// beats a rebuild that never lands.
					Logger.error(`[buildFleetSnapshot] agent map build failed for task ${taskId}`, error)
				}
			}

			const title = fleetTitleOf(instance.getTitle(), instance.controller.id)

			const card: FleetInstance = {
				instanceId: instance.controller.id,
				surface,
				title,
				detached: instance.isDetached(),
				visible: instance.isVisible(),
				taskId,
				status: task ? FLEET_STATUS_BY_TASK_STATUS[task.taskState.status] : "idle",
				agentMap: agentMap === undefined ? undefined : withNamedRoot(agentMap, title),
			}
			return card
		}),
	)

	// Keeps `nonFleet()`'s insertion order; only drops the skipped fleet-panel case above.
	const instances = cards.filter((card): card is FleetInstance => card !== undefined)
	return { generatedAt: Date.now(), instances }
}

/**
 * The label a fleet card carries.
 *
 * Before its first turn an instance has no conversation to be named after, and the placeholder title
 * put "Dirac EXT" on every idle card — which is the opposite of what the fleet map is for. A short
 * slice of the controller id keeps two untouched views tellable apart, which is the whole point of
 * listing them separately.
 * @param recorded The title the tab lifecycle derived from the conversation, if any
 * @param instanceId The instance's controller id
 * @returns A label that is unique across idle instances
 */
function fleetTitleOf(recorded: string | undefined, instanceId: string): string {
	const trimmed = recorded?.trim()
	// An untouched instance does not report an ABSENT title — `applyStateTitle` has already written
	// the placeholder, so `getTitle()` returns "Dirac EXT" and an `?? fallback` never fires. The
	// placeholder is what "unnamed" looks like here, so test for it explicitly.
	if (trimmed && trimmed !== DEFAULT_WEBVIEW_TITLE) {
		return trimmed
	}
	return `New conversation (${instanceId.slice(0, 8)})`
}

/**
 * Replaces a root node titled with the bare task id by the instance's own label.
 *
 * `buildAgentMapSnapshot` names a root after the Goal objective, or — for an ordinary conversation,
 * which has no objective on disk — after the task id. In the per-task overlay that id sits under the
 * conversation the user is reading; on a fleet card it is a bare timestamp directly beneath a
 * perfectly good human title, naming nothing. The map is right; the fleet just knows a better name
 * for the same node, so it supplies it here rather than teaching the shared builder about surfaces.
 * @param snapshot The instance's agent map
 * @param title The instance's fleet label
 * @returns The snapshot, with the root renamed only when it was showing the raw task id
 */
function withNamedRoot(snapshot: AgentMapSnapshot, title: string): AgentMapSnapshot {
	const nodes = snapshot.nodes.map((node) =>
		node.kind === "root" && node.title === snapshot.rootTaskId ? { ...node, title } : node,
	)
	return { ...snapshot, nodes }
}
