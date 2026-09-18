// Data model for the Fleet Map (WP5b): every live Dirac EXT webview instance — the sidebar, every
// editor tab, every detached background task — rendered as one section per instance with its agent
// tree beneath it.
//
// The snapshot is assembled on the extension host from the instance registry and each task's
// on-disk records, then streamed to the fleet panel. The shape lives in shared/ so the producer and
// the view agree on it without either importing the other.

import type { AgentMapSnapshot } from "./agentMap"
import { TaskStatus } from "./ExtensionMessage"

/**
 * The kind of UI surface a fleet-listed instance is hosted in.
 *
 * A fleet panel is never listed: it would appear in its own listing, and the panel's own controller
 * is one it never uses. The type has no `"fleet"` member so a fleet instance cannot be described by
 * it even by accident.
 */
export type FleetInstanceSurface = "sidebar" | "tab"

/**
 * The lifecycle status drawn as a fleet card's dot.
 *
 * Deliberately has NO `"failed"` member: `TaskStatus` has no failed state, and a status that cannot
 * occur would be a lie drawn as a dot. The exhaustive `FLEET_STATUS_BY_TASK_STATUS` record below is
 * what keeps a new upstream status from inventing one silently.
 */
export type FleetInstanceStatus = "idle" | "running" | "waiting" | "completed" | "cancelled"

/**
 * One live Dirac EXT instance as the fleet panel renders it.
 */
export interface FleetInstance {
	/** The instance's controller id — the stable handle reveal uses to find it again. */
	instanceId: string
	surface: FleetInstanceSurface
	/** The title the tab lifecycle already maintains; "Dirac EXT" before the first turn. */
	title: string
	/** True when the task outlived its webview and is running without one. */
	detached: boolean
	visible: boolean
	taskId?: string
	status: FleetInstanceStatus
	/** Absent when the instance has no task — the card reads "No conversation yet". */
	agentMap?: AgentMapSnapshot
}

/**
 * The whole fleet, rebuilt and pushed on every change the panel needs to know about.
 */
export interface FleetSnapshot {
	generatedAt: number
	instances: FleetInstance[]
}

/**
 * Maps every `TaskStatus` onto the fleet dot it draws.
 *
 * An exhaustive `Record`, not a switch with a default, so that a new upstream `TaskStatus` breaks
 * compilation here instead of silently drawing the wrong dot. Everything that means "the agent is
 * doing something" collapses to `"running"` — the fleet map distinguishes idle / running / waiting /
 * done, not the streaming phases underneath.
 */
export const FLEET_STATUS_BY_TASK_STATUS: Record<TaskStatus, FleetInstanceStatus> = {
	[TaskStatus.IDLE]: "idle",
	[TaskStatus.COMPLETED]: "completed",
	[TaskStatus.CANCELLED]: "cancelled",
	[TaskStatus.AWAITING_USER_INPUT]: "waiting",
	[TaskStatus.PREPARING]: "running",
	[TaskStatus.WAITING_FOR_API]: "running",
	[TaskStatus.THINKING]: "running",
	[TaskStatus.STREAMING_TEXT]: "running",
	[TaskStatus.BUILDING_TOOL_CALL]: "running",
	[TaskStatus.EXECUTING_TOOL]: "running",
	[TaskStatus.BUILDING_REQUEST]: "running",
	[TaskStatus.CANCELLING]: "running",
}
