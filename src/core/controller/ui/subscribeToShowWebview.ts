import { EmptyRequest } from "@shared/proto/dirac/common"
import { ShowWebviewEvent } from "@shared/proto/dirac/ui"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"

// Keep track of active show webview subscriptions
const showWebviewSubscriptions = new Map<string, Set<StreamingResponseHandler<ShowWebviewEvent>>>()

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
	let subscriptions = showWebviewSubscriptions.get(controller.id)
	if (!subscriptions) {
		subscriptions = new Set<StreamingResponseHandler<ShowWebviewEvent>>()
		showWebviewSubscriptions.set(controller.id, subscriptions)
	}
	subscriptions.add(responseStream)

	// Register cleanup when the connection is closed
	const cleanup = () => {
		const currentSubscriptions = showWebviewSubscriptions.get(controller.id)
		if (currentSubscriptions) {
			currentSubscriptions.delete(responseStream)
			if (currentSubscriptions.size === 0) {
				showWebviewSubscriptions.delete(controller.id)
			}
		}
	}

	// Register the cleanup function with the request registry if we have a requestId
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "show_webview_subscription" }, responseStream)
	}
}

/**
 * Send a show webview event to all subscribers of a specific controller's webview
 * @param controllerId The id of the controller whose webview should receive the event
 * @param preserveEditorFocus When true, the webview should not steal focus from the editor
 */
export async function sendShowWebviewEvent(controllerId: string, preserveEditorFocus = false): Promise<void> {
	// Get the subscriptions for this specific controller
	const responseStreams = showWebviewSubscriptions.get(controllerId)

	if (!responseStreams || responseStreams.size === 0) {
		return
	}

	const event = ShowWebviewEvent.create({ preserveEditorFocus })

	await Promise.all(
		Array.from(responseStreams).map(async (responseStream) => {
			try {
				await responseStream(
					event,
					false, // Not the last message
				)
			} catch (error) {
				Logger.error("Error sending show webview event:", error)
				// Remove the subscription if there was an error
				const currentSubscriptions = showWebviewSubscriptions.get(controllerId)
				if (currentSubscriptions) {
					currentSubscriptions.delete(responseStream)
					if (currentSubscriptions.size === 0) {
						showWebviewSubscriptions.delete(controllerId)
					}
				}
			}
		}),
	)
}
