import { Empty, EmptyRequest } from "@shared/proto/dirac/common"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

// Keep track of active account button clicked subscriptions
const activeAccountButtonClickedSubscriptions = new Map<string, Set<StreamingResponseHandler<Empty>>>()

/**
 * Subscribe to account button clicked events
 * @param controller The controller instance
 * @param request The empty request
 * @param responseStream The streaming response handler
 * @param requestId The request ID for cleanup
 */
export async function subscribeToAccountButtonClicked(
	controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<Empty>,
	requestId?: string,
): Promise<void> {
	// Add this subscription to the active subscriptions
	let subscriptions = activeAccountButtonClickedSubscriptions.get(controller.id)
	if (!subscriptions) {
		subscriptions = new Set<StreamingResponseHandler<Empty>>()
		activeAccountButtonClickedSubscriptions.set(controller.id, subscriptions)
	}
	subscriptions.add(responseStream)

	// Register cleanup when the connection is closed
	const cleanup = () => {
		const currentSubscriptions = activeAccountButtonClickedSubscriptions.get(controller.id)
		if (currentSubscriptions) {
			currentSubscriptions.delete(responseStream)
			if (currentSubscriptions.size === 0) {
				activeAccountButtonClickedSubscriptions.delete(controller.id)
			}
		}
	}

	// Register the cleanup function with the request registry if we have a requestId
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "accountButtonClicked_subscription" }, responseStream)
	}
}

/**
 * Send an account button clicked event to all subscribers of a specific controller's webview
 * @param controllerId The id of the controller whose webview should receive the event
 */
export async function sendAccountButtonClickedEvent(controllerId: string): Promise<void> {
	// Get the subscriptions for this specific controller
	const responseStreams = activeAccountButtonClickedSubscriptions.get(controllerId)

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
				Logger.error("Error sending accountButtonClicked event:", error)
				// Remove the subscription if there was an error
				const currentSubscriptions = activeAccountButtonClickedSubscriptions.get(controllerId)
				if (currentSubscriptions) {
					currentSubscriptions.delete(responseStream)
					if (currentSubscriptions.size === 0) {
						activeAccountButtonClickedSubscriptions.delete(controllerId)
					}
				}
			}
		}),
	)
}
