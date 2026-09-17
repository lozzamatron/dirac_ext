import { EmptyRequest } from "@shared/proto/dirac/common"
import { State } from "@shared/proto/dirac/state"
import { telemetryService } from "@/services/telemetry"
import { ExtensionState } from "@/shared/ExtensionMessage"
import type { PresentationBatch } from "@/shared/PresentationOperation"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

// Keep track of active state subscriptions by controller ID
const activeStateSubscriptions = new Map<string, StreamingResponseHandler<State>>()
const subscriptionDeliveries = new WeakMap<StreamingResponseHandler<State>, Promise<void>>()

export async function subscribeToState(
	controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<State>,
	requestId?: string,
): Promise<void> {
	const controllerId = controller.id
	const cleanup = () => {
		if (activeStateSubscriptions.get(controllerId) === responseStream) {
			activeStateSubscriptions.delete(controllerId)
		}
	}

	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "state_subscription" }, responseStream)
	}

	try {
		const initialDelivery = enqueueSubscriptionDelivery(responseStream, async () => {
			await sendStateToSubscription(await controller.getStateToPostToWebview(), responseStream, 0)
		})
		activeStateSubscriptions.set(controllerId, responseStream)
		await initialDelivery
	} catch (error) {
		Logger.error("Error publishing initial state:", error)
		if (activeStateSubscriptions.get(controllerId) === responseStream) {
			activeStateSubscriptions.delete(controllerId)
		}
	}
}

export async function sendStateUpdate(
	controllerId: string,
	state: Partial<ExtensionState>,
	sequenceNumber: number,
	presentation?: PresentationBatch,
): Promise<void> {
	const responseStream = activeStateSubscriptions.get(controllerId)
	if (!responseStream) {
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

	try {
		await enqueueSubscriptionDelivery(responseStream, () =>
			responseStream({ stateJson, presentationJson }, false, sequenceNumber),
		)
	} catch (error) {
		Logger.error(`[StatePublication] Delivery failed sequence=${sequenceNumber}.`, error)
		if (activeStateSubscriptions.get(controllerId) === responseStream) {
			activeStateSubscriptions.delete(controllerId)
		}
	}
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
