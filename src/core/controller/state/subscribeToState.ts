import { EmptyRequest } from "@shared/proto/dirac/common"
import { State } from "@shared/proto/dirac/state"
import { telemetryService } from "@/services/telemetry"
import { ExtensionState } from "@/shared/ExtensionMessage"
import type { PresentationBatch } from "@/shared/PresentationOperation"
import { Logger } from "@/shared/services/Logger"
import { notifyFleetChanged } from "@core/controller/fleet/subscribeToFleet"
import { applyStateTitle } from "@core/webview/taskTitle"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

// Active state subscriptions, routed per controller. The value is a Set because one webview can
// legitimately subscribe more than once (two React components each call useChatState()), and a
// single-handler map silently dropped the earlier subscriber.
const activeStateSubscriptions = new Map<string, Set<StreamingResponseHandler<State>>>()
const subscriptionDeliveries = new WeakMap<StreamingResponseHandler<State>, Promise<void>>()

export async function subscribeToState(
	controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<State>,
	requestId?: string,
): Promise<void> {
	const controllerId = controller.id
	const removeSubscription = () => {
		const subscriptions = activeStateSubscriptions.get(controllerId)
		if (!subscriptions) {
			return
		}
		subscriptions.delete(responseStream)
		if (subscriptions.size === 0) {
			activeStateSubscriptions.delete(controllerId)
		}
	}
	const cleanup = () => {
		removeSubscription()
	}

	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "state_subscription" }, responseStream)
	}

	try {
		const initialDelivery = enqueueSubscriptionDelivery(responseStream, async () => {
			const initialState = await controller.getStateToPostToWebview()
			// Dirac EXT: a tab opened on an existing conversation would otherwise keep the default
			// title until the next publication, which for a finished task never comes.
			applyStateTitle(controllerId, initialState)
			await sendStateToSubscription(initialState, responseStream, 0)
		})
		let subscriptions = activeStateSubscriptions.get(controllerId)
		if (!subscriptions) {
			subscriptions = new Set<StreamingResponseHandler<State>>()
			activeStateSubscriptions.set(controllerId, subscriptions)
		}
		subscriptions.add(responseStream)
		await initialDelivery
	} catch (error) {
		Logger.error("Error publishing initial state:", error)
		removeSubscription()
	}
}

export async function sendStateUpdate(
	controllerId: string,
	state: Partial<ExtensionState>,
	sequenceNumber: number,
	presentation?: PresentationBatch,
): Promise<void> {
	// Dirac EXT: before the early return below — a detached or not-yet-subscribed surface still has a
	// title worth keeping current, and it is what the re-attach quick pick labels the task with.
	applyStateTitle(controllerId, state)

	// Dirac EXT: a state publication is the natural "something changed in this conversation" signal,
	// so it is what keeps the Fleet Map current. A no-op when no fleet panel is subscribed, and
	// coalesced through the fleet's own throttle when one is — this runs on every publication.
	notifyFleetChanged()

	const subscriptions = activeStateSubscriptions.get(controllerId)
	if (!subscriptions || subscriptions.size === 0) {
		return
	}

	let stateJson: string
	let presentationJson: string | undefined
	try {
		stateJson = JSON.stringify(state)
		presentationJson = presentation ? JSON.stringify(presentation) : undefined
	} catch (error) {
		Logger.error(`[StatePublication] Failed to serialize sequence=${sequenceNumber}.`, error)
		throw error
	}

	const sizeBytes = Buffer.byteLength(stateJson, "utf8") + (presentationJson ? Buffer.byteLength(presentationJson, "utf8") : 0)
	recordStateSizeTelemetry(sizeBytes)

	// Iterate a copy: a failing delivery removes its handler from the live set.
	const promises = Array.from(subscriptions).map(async (responseStream) => {
		try {
			await enqueueSubscriptionDelivery(responseStream, () =>
				responseStream({ stateJson, presentationJson }, false, sequenceNumber),
			)
		} catch (error) {
			Logger.error(`[StatePublication] Delivery failed sequence=${sequenceNumber}.`, error)
			const current = activeStateSubscriptions.get(controllerId)
			if (current) {
				current.delete(responseStream)
				if (current.size === 0) {
					activeStateSubscriptions.delete(controllerId)
				}
			}
		}
	})

	await Promise.all(promises)
}

function enqueueSubscriptionDelivery(
	responseStream: StreamingResponseHandler<State>,
	deliver: () => Promise<void>,
): Promise<void> {
	const previous = subscriptionDeliveries.get(responseStream) ?? Promise.resolve()
	const delivery = previous.then(deliver)
	subscriptionDeliveries.set(responseStream, delivery)
	return delivery
}

async function sendStateToSubscription(
	state: ExtensionState,
	responseStream: StreamingResponseHandler<State>,
	sequenceNumber: number,
): Promise<void> {
	const stateJson = JSON.stringify(state)
	recordStateSizeTelemetry(Buffer.byteLength(stateJson, "utf8"))
	await responseStream({ stateJson }, false, sequenceNumber)
}

function recordStateSizeTelemetry(sizeBytes: number): void {
	telemetryService.captureGrpcResponseSize(sizeBytes, "dirac.StateService", "subscribeToState")
}
