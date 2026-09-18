// gRPC handler for the per-task Agent Map overlay: returns the task's map as JSON
// for the webview to draw. The snapshot itself is assembled from the task's
// on-disk records — not from the webview's messages — because only the records
// show a Goal's grandchildren and any run whose cards have left the transcript.
//
// The assembly lives in `buildAgentMapSnapshot.ts`, shared with the fleet map's
// per-instance card builder (WP5b): two readers of the same records must call one
// builder, or the overlay and the fleet map will drift apart about the same
// conversation. This file is only the RPC wrapper around it.

import { buildAgentMapSnapshot } from "@core/controller/agentMap/buildAgentMapSnapshot"
import { AgentMapSnapshotResponse } from "@shared/proto/dirac/agent_map"
import type { StringRequest } from "@shared/proto/dirac/common"
import type { Controller } from "../index"

/**
 * Builds the Agent Map snapshot for a task and returns it serialized as JSON in
 * `snapshotJson`. All the work — and all the fail-soft handling of missing or
 * malformed on-disk records — is in {@link buildAgentMapSnapshot}.
 * @param _controller The controller instance (unused; the map is derived from disk)
 * @param request The task id to build the map for
 * @returns The snapshot, serialized as JSON in `snapshotJson`
 */
export async function getAgentMap(_controller: Controller, request: StringRequest): Promise<AgentMapSnapshotResponse> {
	const snapshot = await buildAgentMapSnapshot(request.value?.trim() ?? "")
	return AgentMapSnapshotResponse.create({ snapshotJson: JSON.stringify(snapshot) })
}
