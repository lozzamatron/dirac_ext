import type { EmptyRequest, String as ProtoString } from "@shared/proto/dirac/common"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"

// Keep track of active addToInput subscriptions
const activeAddToInputSubscriptions = new Map<string, Set<StreamingResponseHandler<ProtoString>>>()

/**
 * Subscribe to addToInput events
 * @param controller The controller instance
 * @param request The empty request
 * @param responseStream The streaming response handler
 * @param requestId The ID of the request (passed by the gRPC handler)
 */
export async function subscribeToAddToInput(
	controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<ProtoString>,
	requestId?: string,
): Promise<void> {
	// Add this subscription to the active subscriptions
	let subscriptions = activeAddToInputSubscriptions.get(controller.id)
	if (!subscriptions) {
		subscriptions = new Set<StreamingResponseHandler<ProtoString>>()
		activeAddToInputSubscriptions.set(controller.id, subscriptions)
	}
	subscriptions.add(responseStream)

	// Register cleanup when the connection is closed
	const cleanup = () => {
		const currentSubscriptions = activeAddToInputSubscriptions.get(controller.id)
		if (currentSubscriptions) {
			currentSubscriptions.delete(responseStream)
			if (currentSubscriptions.size === 0) {
				activeAddToInputSubscriptions.delete(controller.id)
			}
		}
	}

	// Register the cleanup function with the request registry if we have a requestId
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "addToInput_subscription" }, responseStream)
	}
}

/**
 * Send an addToInput event to all subscribers of a specific controller's webview
 * @param controllerId The id of the controller whose webview should receive the event
 * @param text The text to add to the input
 */
export async function sendAddToInputEvent(controllerId: string, text: string): Promise<void> {
	// Get the subscriptions for this specific controller
	const responseStreams = activeAddToInputSubscriptions.get(controllerId)

	if (!responseStreams || responseStreams.size === 0) {
		return
	}

	const event: ProtoString = {
		value: text,
	}

	await Promise.all(
		Array.from(responseStreams).map(async (responseStream) => {
			try {
				await responseStream(
					event,
					false, // Not the last message
				)
			} catch (error) {
				Logger.error("Error sending addToInput event:", error)
				// Remove the subscription if there was an error
				const currentSubscriptions = activeAddToInputSubscriptions.get(controllerId)
				if (currentSubscriptions) {
					currentSubscriptions.delete(responseStream)
					if (currentSubscriptions.size === 0) {
						activeAddToInputSubscriptions.delete(controllerId)
					}
				}
			}
		}),
	)
}
