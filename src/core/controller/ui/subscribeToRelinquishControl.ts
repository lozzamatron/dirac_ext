import { Empty, EmptyRequest } from "@shared/proto/dirac/common"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

// Keep track of active subscriptions
const activeRelinquishControlSubscriptions = new Map<string, StreamingResponseHandler<Empty>>()

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
	activeRelinquishControlSubscriptions.set(controller.id, responseStream)

	// Register cleanup when the connection is closed
	const cleanup = () => {
		if (activeRelinquishControlSubscriptions.get(controller.id) === responseStream) {
			activeRelinquishControlSubscriptions.delete(controller.id)
		}
	}

	// Register the cleanup function with the request registry if we have a requestId
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "relinquish_control_subscription" }, responseStream)
	}
}

/**
 * Send a relinquish control event to a specific controller's webview
 * @param controllerId The id of the controller whose webview should receive the event
 */
export async function sendRelinquishControlEvent(controllerId: string): Promise<void> {
	// Get the subscription for this specific controller
	const responseStream = activeRelinquishControlSubscriptions.get(controllerId)

	if (!responseStream) {
		return
	}

	try {
		const event = Empty.create({})
		await responseStream(
			event,
			false, // Not the last message
		)
	} catch (error) {
		Logger.error("Error sending relinquish control event:", error)
		// Remove the subscription if there was an error
		activeRelinquishControlSubscriptions.delete(controllerId)
	}
}
