import type { EmptyRequest, String as ProtoString } from "@shared/proto/dirac/common"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"

// Keep track of active addToInput subscriptions
const activeAddToInputSubscriptions = new Map<string, StreamingResponseHandler<ProtoString>>()

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
	activeAddToInputSubscriptions.set(controller.id, responseStream)

	// Register cleanup when the connection is closed
	const cleanup = () => {
		if (activeAddToInputSubscriptions.get(controller.id) === responseStream) {
			activeAddToInputSubscriptions.delete(controller.id)
		}
	}

	// Register the cleanup function with the request registry if we have a requestId
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "addToInput_subscription" }, responseStream)
	}
}

/**
 * Send an addToInput event to a specific controller's webview
 * @param controllerId The id of the controller whose webview should receive the event
 * @param text The text to add to the input
 */
export async function sendAddToInputEvent(controllerId: string, text: string): Promise<void> {
	// Get the subscription for this specific controller
	const responseStream = activeAddToInputSubscriptions.get(controllerId)

	if (!responseStream) {
		return
	}

	try {
		const event: ProtoString = {
			value: text,
		}
		await responseStream(
			event,
			false, // Not the last message
		)
	} catch (error) {
		Logger.error("Error sending addToInput event:", error)
		// Remove the subscription if there was an error
		activeAddToInputSubscriptions.delete(controllerId)
	}
}
