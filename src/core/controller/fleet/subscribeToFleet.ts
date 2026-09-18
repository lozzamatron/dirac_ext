import type { EmptyRequest } from "@shared/proto/dirac/common"
import { FleetSnapshotResponse } from "@shared/proto/dirac/fleet"
import { buildFleetSnapshot } from "@core/controller/fleet/buildFleetSnapshot"
import { webviewInstances } from "@core/webview/InstanceRegistry"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"

// ONE global set, not a Map keyed by controller id. subscribeToAddToInput keys its subscriptions by
// controller because each addToInput event targets one webview; a fleet snapshot has no such target —
// every fleet panel sees the same fleet, so there is nothing to key by. A per-controller Map would
// make the singleton panel's second open either a second stream or a silent no-op, with no way to
// tell which; one global set makes both questions moot.
const activeFleetSubscriptions = new Set<StreamingResponseHandler<FleetSnapshotResponse>>()

// Lazily-attached infrastructure, alive only while at least one subscriber exists. An interval that
// outlives its subscribers is a leak that rebuilds forever against nobody; the registry subscription
// is the same story with an event source nobody is listening to.
let registrySubscription: { dispose(): void } | undefined
let safetyInterval: ReturnType<typeof setInterval> | undefined

// Coalescing state (spec D4): a 750ms trailing throttle, plus a dirty flag so a rebuild already in
// flight never starts a second one — each rebuild does disk reads per instance, and overlapping them
// under a busy fleet is how this becomes the slow part of the extension.
const FLEET_PUSH_THROTTLE_MS = 750
const FLEET_SAFETY_INTERVAL_MS = 5000
let pushTimer: ReturnType<typeof setTimeout> | undefined
let rebuildInFlight = false
let rebuildDirty = false

/**
 * Subscribe to fleet snapshots.
 *
 * Follows subscribeToAddToInput's shape — active-subscription set, cleanup closure, request-registry
 * registration, send loop that drops a handler whose delivery threw — with the one structural
 * difference noted above: a single global subscription set.
 *
 * @param _controller The controller instance. Unused: the fleet is not keyed by controller, but the
 *   gRPC handler's signature passes it to every service method, so it is named to satisfy the linter
 *   the same way subscribeToAddToInput names its unused request.
 * @param _request The empty request
 * @param responseStream The streaming response handler
 * @param requestId The ID of the request (passed by the gRPC handler)
 */
export async function subscribeToFleet(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<FleetSnapshotResponse>,
	requestId?: string,
): Promise<void> {
	activeFleetSubscriptions.add(responseStream)

	// Register cleanup when the connection is closed.
	const cleanup = (): void => {
		removeSubscription(responseStream)
	}

	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "fleet_subscription" }, responseStream)
	}

	ensureInfrastructure()

	// Push immediately so a newly opened panel is never blank. Fired, not awaited: the RPC must
	// return now and let the snapshot land when it lands.
	void rebuildAndPush()
}

/**
 * Asks for a fleet rebuild. Cheap and safe to call often — coalesced.
 *
 * Called from outside this module (the state pipeline, on every state publication) and from the
 * registry listener and safety interval set up here. A no-op when nobody is subscribed, so calling
 * it on every state publication costs nothing while the fleet panel is closed.
 */
export function notifyFleetChanged(): void {
	if (activeFleetSubscriptions.size === 0) {
		return
	}
	scheduleFleetPush()
}

/**
 * Removes a handler from the subscription set, and tears the infrastructure down when the last one
 * leaves — the registry listener and the 5s safety interval exist only for subscribers.
 */
function removeSubscription(handler: StreamingResponseHandler<FleetSnapshotResponse>): void {
	activeFleetSubscriptions.delete(handler)
	if (activeFleetSubscriptions.size > 0) {
		return
	}
	if (registrySubscription) {
		registrySubscription.dispose()
		registrySubscription = undefined
	}
	if (safetyInterval !== undefined) {
		clearInterval(safetyInterval)
		safetyInterval = undefined
	}
}

/**
 * Attaches the registry listener and the safety interval, the first time a subscriber appears.
 *
 * The registry listener covers instance register/unregister; the interval covers subagent progress,
 * which reaches runs.json without any state publication — without it a running tree freezes on
 * screen (spec D4 point 4).
 */
function ensureInfrastructure(): void {
	if (!registrySubscription) {
		registrySubscription = webviewInstances.onDidChange(() => {
			notifyFleetChanged()
		})
	}
	if (safetyInterval === undefined) {
		safetyInterval = setInterval(() => {
			notifyFleetChanged()
		}, FLEET_SAFETY_INTERVAL_MS)
	}
}

/**
 * Schedules a rebuild-and-push after the trailing throttle window. Triggers landing inside the
 * window coalesce into the one scheduled push.
 */
function scheduleFleetPush(): void {
	if (pushTimer !== undefined) {
		return
	}
	pushTimer = setTimeout(() => {
		pushTimer = undefined
		void rebuildAndPush()
	}, FLEET_PUSH_THROTTLE_MS)
}

/**
 * Builds one snapshot and delivers it to every subscriber.
 *
 * A rebuild already in flight sets the dirty flag instead of starting a second one; the dirty flag
 * is consumed when the in-flight rebuild finishes, so the last trigger still produces a push. A
 * builder that throws is logged and leaves the throttle usable — one failed rebuild must not
 * permanently wedge the panel.
 */
async function rebuildAndPush(): Promise<void> {
	if (rebuildInFlight) {
		rebuildDirty = true
		return
	}
	rebuildInFlight = true
	try {
		const snapshot = await buildFleetSnapshot()
		const event = FleetSnapshotResponse.create({ snapshotJson: JSON.stringify(snapshot) })
		await deliverToFleetSubscribers(event)
	} catch (error) {
		Logger.error("Failed to build or push fleet snapshot:", error)
	} finally {
		rebuildInFlight = false
		if (rebuildDirty) {
			rebuildDirty = false
			// Through the throttle again, so a burst of triggers during the in-flight rebuild still
			// coalesces into one further push rather than one per trigger.
			scheduleFleetPush()
		}
	}
}

/**
 * Delivers the snapshot to every subscriber, iterating a COPY of the set and removing any handler
 * whose delivery threw — exactly as subscribeToAddToInput does.
 */
async function deliverToFleetSubscribers(event: FleetSnapshotResponse): Promise<void> {
	if (activeFleetSubscriptions.size === 0) {
		return
	}

	await Promise.all(
		Array.from(activeFleetSubscriptions).map(async (responseStream) => {
			try {
				await responseStream(
					event,
					false, // Not the last message
				)
			} catch (error) {
				Logger.error("Error sending fleet snapshot:", error)
				removeSubscription(responseStream)
			}
		}),
	)
}
