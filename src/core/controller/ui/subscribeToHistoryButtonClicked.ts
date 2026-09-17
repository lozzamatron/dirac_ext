import { Empty, EmptyRequest } from "@shared/proto/dirac/common"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

// Keep track of active history button clicked subscriptions
const activeHistoryButtonClickedSubscriptions = new Map<string, StreamingResponseHandler<Empty>>()

/**
 * Subscribe to history button clicked events
 * @param controller The controller instance
 * @param request The empty request
 * @param responseStream The streaming response handler
 * @param requestId The ID of the request (passed by the gRPC handler)
 */
export async function subscribeToHistoryButtonClicked(
	controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<Empty>,
	requestId?: string,
): Promise<void> {
	// Add this subscription to the active subscriptions
	activeHistoryButtonClickedSubscriptions.set(controller.id, responseStream)

	// Register cleanup when the connection is closed
	const cleanup = () => {
		if (activeHistoryButtonClickedSubscriptions.get(controller.id) === responseStream) {
			activeHistoryButtonClickedSubscriptions.delete(controller.id)
		}
	}

	// Register the cleanup function with the request registry if we have a requestId
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "history_button_clicked_subscription" }, responseStream)
	}
}

/**
 * Send a history button clicked event to a specific controller's webview
 * @param controllerId The id of the controller whose webview should receive the event
 */
export async function sendHistoryButtonClickedEvent(controllerId: string): Promise<void> {
	// Get the subscription for this specific controller
	const responseStream = activeHistoryButtonClickedSubscriptions.get(controllerId)

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
		Logger.error("Error sending history button clicked event:", error)
		// Remove the subscription if there was an error
		activeHistoryButtonClickedSubscriptions.delete(controllerId)
	}
}
