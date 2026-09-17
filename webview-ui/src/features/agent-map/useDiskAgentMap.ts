// Fetches the host's disk-read Agent Map for a task, once per opening of the overlay.
//
// Fetched on open rather than kept in sync: the records only change when a subagent settles, the
// live map already reflects that within the same second, and polling the disk behind a modal nobody
// is looking at would be work with no reader.
import type { AgentMapSnapshot } from "@shared/agentMap"
import { StringRequest } from "@shared/proto/dirac/common"
import { useEffect, useState } from "react"
import { AgentMapServiceClient } from "@/shared/api/grpc-client"

/**
 * @param open - Whether the overlay is showing; the request is made on the transition to true.
 * @param taskId - The conversation's task id; nothing is fetched without one.
 * @returns The host's snapshot, or undefined until (or unless) one arrives.
 */
export function useDiskAgentMap(open: boolean, taskId: string): AgentMapSnapshot | undefined {
	const [snapshot, setSnapshot] = useState<AgentMapSnapshot | undefined>(undefined)

	useEffect(() => {
		// Clear first, always. The state outlives the effect, so without this the PREVIOUS task's
		// grandchildren stay on screen under the new conversation's title for as long as the new
		// request takes — one conversation's agents drawn under another's name.
		setSnapshot(undefined)
		if (!open || taskId === "") {
			return
		}
		// Guards a response that arrives after the overlay closed or the task changed: applying it
		// then would show one conversation's agents under another's title.
		let active = true
		AgentMapServiceClient.getAgentMap(StringRequest.create({ value: taskId }))
			.then((response) => {
				if (!active) {
					return
				}
				const parsed = parseSnapshot(response.snapshotJson)
				setSnapshot(parsed)
			})
			.catch((error) => {
				// The live map is already on screen and is the more important half. A failed disk read
				// costs the user the grandchildren, not the map, so log it and leave the map alone.
				console.error("Failed to read the Agent Map from disk:", error)
			})
		return () => {
			active = false
		}
	}, [open, taskId])

	return snapshot
}

function parseSnapshot(json: string): AgentMapSnapshot | undefined {
	if (!json) {
		return undefined
	}
	try {
		const value: unknown = JSON.parse(json)
		if (typeof value !== "object" || value === null || !Array.isArray((value as AgentMapSnapshot).nodes)) {
			return undefined
		}
		return value as AgentMapSnapshot
	} catch (error) {
		console.error("Agent Map snapshot from the host was not valid JSON:", error)
		return undefined
	}
}
