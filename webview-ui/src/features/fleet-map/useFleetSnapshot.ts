// Subscribes the fleet panel to the host's fleet stream: one push per fleet change, carrying the
// whole snapshot each time. The subscription lives exactly as long as the panel — the host keeps
// pushing otherwise, and a panel that closed without cancelling would leak a stream per open.
import type { FleetSnapshot } from "@shared/fleet"
import { EmptyRequest } from "@shared/proto/dirac/common"
import { useEffect, useState } from "react"
import { FleetServiceClient } from "@/shared/api/grpc-client"

/**
 * The latest fleet snapshot the host has pushed, or `undefined` before the first valid one arrives.
 *
 * @returns The last good snapshot, held across malformed events and stream errors so the panel never
 *   blanks mid-session.
 */
export function useFleetSnapshot(): FleetSnapshot | undefined {
	const [snapshot, setSnapshot] = useState<FleetSnapshot | undefined>(undefined)

	useEffect(() => {
		// Empty dependency array on purpose: the subscription is per-panel, not per-render, and
		// resubscribing on every state change would drop events between the unsubscribe and the
		// resubscribe — a fleet card could vanish for a tick for no reason a user could see.
		return FleetServiceClient.subscribeToFleet({} as EmptyRequest, {
			onResponse: (event) => {
				const parsed = parseFleetSnapshot(event.snapshotJson)
				if (parsed) {
					setSnapshot(parsed)
				}
				// A malformed event is ignored, not applied as undefined: the fleet is still fine on the
				// host side, and blanking the panel because one push failed to parse would read to the
				// user as "every instance just died". The next valid push replaces this snapshot anyway.
			},
			onError: (error) => {
				// Same reasoning as above: an error ends the stream, not the fleet. The last good
				// snapshot stays on screen — a stale fleet map is recoverable by reopening the panel,
				// a blanked one looks like data loss.
				console.error("Fleet stream errored; keeping the last known fleet snapshot:", error)
			},
			onComplete: () => {},
		})
	}, [])

	return snapshot
}

// Same shape of guard as useDiskAgentMap's parseSnapshot: the JSON crosses a wire from the host and
// is untrusted here, so anything that is not the expected shape is rejected whole rather than
// partially applied.
function parseFleetSnapshot(json: string): FleetSnapshot | undefined {
	if (!json) {
		return undefined
	}
	try {
		const value: unknown = JSON.parse(json)
		if (typeof value !== "object" || value === null || !Array.isArray((value as FleetSnapshot).instances)) {
			return undefined
		}
		return value as FleetSnapshot
	} catch (error) {
		console.error("Fleet snapshot from the host was not valid JSON:", error)
		return undefined
	}
}

