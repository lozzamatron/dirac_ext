import { Empty, EmptyRequest } from "@shared/proto/dirac/common"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

// Keep track of active subscriptions
const activeRelinquishControlSubscriptions = new Map<string, Set<StreamingResponseHandler<Empty>>>()

/**
 * Subscribe to relinquish control events
 * @param controller The controller instance
 * @param request The empty request
 * @param responseStream The streaming response handler
 * @param requestId The ID of the request (passed by the gRPC handler)
 */
export async function subscribeToRelinquishControl(
	controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<Empty>,
	requestId?: string,
): Promise<void> {
	// Add this subscription to the active subscriptions
	let subscriptions = activeRelinquishControlSubscriptions.get(controller.id)
	if (!subscriptions) {
		subscriptions = new Set<StreamingResponseHandler<Empty>>()
		activeRelinquishControlSubscriptions.set(controller.id, subscriptions)
	}
	subscriptions.add(responseStream)

	// Register cleanup when the connection is closed
	const cleanup = () => {
		const currentSubscriptions = activeRelinquishControlSubscriptions.get(controller.id)
		if (currentSubscriptions) {
			currentSubscriptions.delete(responseStream)
			if (currentSubscriptions.size === 0) {
				activeRelinquishControlSubscriptions.delete(controller.id)
			}
		}
	}

	// Register the cleanup function with the request registry if we have a requestId
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "relinquish_control_subscription" }, responseStream)
	}
}

/**
 * Send a relinquish control event to all subscribers of a specific controller's webview
 * @param controllerId The id of the controller whose webview should receive the event
 */
export async function sendRelinquishControlEvent(controllerId: string): Promise<void> {
	// Get the subscriptions for this specific controller
	const responseStreams = activeRelinquishControlSubscriptions.get(controllerId)

	if (!responseStreams || responseStreams.size === 0) {
		return
	}

	const event = Empty.create({})

	await Promise.all(
		Array.from(responseStreams).map(async (responseStream) => {
			try {
				await responseStream(
					event,
					false, // Not the last message
				)
			} catch (error) {
				Logger.error("Error sending relinquish control event:", error)
				// Remove the subscription if there was an error
				const currentSubscriptions = activeRelinquishControlSubscriptions.get(controllerId)
				if (currentSubscriptions) {
					currentSubscriptions.delete(responseStream)
					if (currentSubscriptions.size === 0) {
						activeRelinquishControlSubscriptions.delete(controllerId)
					}
				}
			}
		}),
	)
}
