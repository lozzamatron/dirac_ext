import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { EmptyRequest } from "@shared/proto/dirac/common"
import type { ExtensionState } from "@shared/ExtensionMessage"
import type { Controller } from "../../index"
import { getRequestRegistry } from "../../grpc-handler"
import { sendStateUpdate, subscribeToState } from "../subscribeToState"

/**
 * Dirac EXT: state is routed per controller so a second webview cannot be fed the first one's
 * state, and each controller keeps a SET of handlers because one webview legitimately subscribes
 * more than once (two React components each call useChatState()). A single-handler map silently
 * dropped the earlier subscriber — that bug reached the browser once already.
 */
describe("subscribeToState routing", () => {
	const makeController = (id: string, state: ExtensionState) =>
		({ id, getStateToPostToWebview: async () => state }) as unknown as Controller

	it("delivers an update to every subscriber of that controller and to no other controller", async () => {
		const state = { version: "test" } as ExtensionState
		const a1: string[] = []
		const a2: string[] = []
		const b1: string[] = []
		const ids = ["route-a-1", "route-a-2", "route-b-1"]

		try {
			await subscribeToState(
				makeController("controller-a", state),
				EmptyRequest.create(),
				async (response) => {
					a1.push(response.stateJson ?? "")
				},
				ids[0],
			)
			await subscribeToState(
				makeController("controller-a", state),
				EmptyRequest.create(),
				async (response) => {
					a2.push(response.stateJson ?? "")
				},
				ids[1],
			)
			await subscribeToState(
				makeController("controller-b", state),
				EmptyRequest.create(),
				async (response) => {
					b1.push(response.stateJson ?? "")
				},
				ids[2],
			)

			const initialA1 = a1.length
			const initialA2 = a2.length
			const initialB1 = b1.length

			await sendStateUpdate("controller-a", { version: "routed" } as Partial<ExtensionState>, 1)

			assert.equal(a1.length, initialA1 + 1, "first subscriber of controller-a received the update")
			assert.equal(a2.length, initialA2 + 1, "second subscriber of the SAME controller also received it")
			assert.equal(b1.length, initialB1, "controller-b received nothing")
			assert.match(a1[a1.length - 1], /"version":"routed"/)
		} finally {
			for (const id of ids) {
				getRequestRegistry().cancelRequest(id)
			}
		}
	})

	it("is a no-op for a controller with no subscription", async () => {
		await sendStateUpdate("controller-with-no-webview", { version: "x" } as Partial<ExtensionState>, 2)
	})

	it("unsubscribing one subscriber leaves the other one live", async () => {
		const state = { version: "test" } as ExtensionState
		const kept: string[] = []
		const dropped: string[] = []
		const keptId = "route-keep"
		const droppedId = "route-drop"

		try {
			await subscribeToState(
				makeController("controller-c", state),
				EmptyRequest.create(),
				async (response) => {
					kept.push(response.stateJson ?? "")
				},
				keptId,
			)
			await subscribeToState(
				makeController("controller-c", state),
				EmptyRequest.create(),
				async (response) => {
					dropped.push(response.stateJson ?? "")
				},
				droppedId,
			)

			getRequestRegistry().cancelRequest(droppedId)
			const keptBefore = kept.length
			const droppedBefore = dropped.length

			await sendStateUpdate("controller-c", { version: "after-unsubscribe" } as Partial<ExtensionState>, 3)

			assert.equal(kept.length, keptBefore + 1, "the remaining subscriber still receives updates")
			assert.equal(dropped.length, droppedBefore, "the cancelled subscriber receives nothing")
		} finally {
			getRequestRegistry().cancelRequest(keptId)
		}
	})
})
