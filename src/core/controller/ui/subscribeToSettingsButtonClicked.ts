import { Empty, EmptyRequest } from "@shared/proto/dirac/common"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"

// Keep track of active settings button clicked subscriptions
const activeSettingsButtonClickedSubscriptions = new Map<string, StreamingResponseHandler<Empty>>()

/**
 * Subscribe to settings button clicked events
 * @param controller The controller instance
 * @param request The empty request
 * @param responseStream The streaming response handler
 * @param requestId The ID of the request (passed by the gRPC handler)
 */
export async function subscribeToSettingsButtonClicked(
	controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<Empty>,
	requestId?: string,
): Promise<void> {
	// Add this subscription to the active subscriptions
	activeSettingsButtonClickedSubscriptions.set(controller.id, responseStream)

	// Register cleanup when the connection is closed
	const cleanup = () => {
		if (activeSettingsButtonClickedSubscriptions.get(controller.id) === responseStream) {
			activeSettingsButtonClickedSubscriptions.delete(controller.id)
		}
	}

	// Register the cleanup function with the request registry if we have a requestId
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "settings_button_clicked_subscription" }, responseStream)
	}
}

/**
 * Send a settings button clicked event to a specific controller's webview
 * @param controllerId The id of the controller whose webview should receive the event
 */
export async function sendSettingsButtonClickedEvent(controllerId: string): Promise<void> {
	// Get the subscription for this specific controller
	const responseStream = activeSettingsButtonClickedSubscriptions.get(controllerId)

	if (!responseStream) {
		return
	}

	try {
		const event = Empty.create({})
		await responseStream(event, false) // Not the last message
	} catch (error) {
		Logger.error("Error sending settings button clicked event:", error)
		activeSettingsButtonClickedSubscriptions.delete(controllerId)
	}
}
