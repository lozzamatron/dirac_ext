import { EmptyRequest } from "@shared/proto/dirac/common"
import { ShowWebviewEvent } from "@shared/proto/dirac/ui"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"

// Keep track of active show webview subscriptions
const showWebviewSubscriptions = new Map<string, StreamingResponseHandler<ShowWebviewEvent>>()

/**
 * Subscribe to show webview events
 * @param controller The controller instance
 * @param request The show webview request containing preserveEditorFocus flag
 * @param responseStream The streaming response handler
 * @param requestId The ID of the request
 */
export async function subscribeToShowWebview(
	controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<ShowWebviewEvent>,
	requestId?: string,
): Promise<void> {
	// Add this subscription to the active subscriptions
	showWebviewSubscriptions.set(controller.id, responseStream)

	// Register cleanup when the connection is closed
	const cleanup = () => {
		if (showWebviewSubscriptions.get(controller.id) === responseStream) {
			showWebviewSubscriptions.delete(controller.id)
		}
	}

	// Register the cleanup function with the request registry if we have a requestId
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "show_webview_subscription" }, responseStream)
	}
}

/**
 * Send a show webview event to a specific controller's webview
 * @param controllerId The id of the controller whose webview should receive the event
 * @param preserveEditorFocus When true, the webview should not steal focus from the editor
 */
export async function sendShowWebviewEvent(controllerId: string, preserveEditorFocus = false): Promise<void> {
	// Get the subscription for this specific controller
	const responseStream = showWebviewSubscriptions.get(controllerId)

	if (!responseStream) {
		return
	}

	try {
		const event = ShowWebviewEvent.create({ preserveEditorFocus })
		await responseStream(
			event,
			false, // Not the last message
		)
	} catch (error) {
		Logger.error("Error sending show webview event:", error)
		// Remove the subscription if there was an error
		showWebviewSubscriptions.delete(controllerId)
	}
}
