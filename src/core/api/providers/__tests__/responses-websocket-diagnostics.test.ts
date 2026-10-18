import assert from "node:assert/strict"
import { describe, it } from "mocha"
import { responsesWebsocketCloseError, responsesWebsocketError } from "../openai-responses-utils"

describe("Responses websocket transport diagnostics", () => {
	it("preserves the underlying transport failure and its cause", () => {
		const cause = new Error("connection reset", { cause: new Error("socket hang up") })
		const error = responsesWebsocketError("Responses websocket error", { error: cause, message: "" })
		assert.equal(error.code, "websocket_error")
		assert.match(error.message, /connection reset/)
		assert.equal(error.cause, cause)
	})
	it("retains the event message when no underlying error is supplied", () => {
		assert.match(responsesWebsocketError("Connect failed", { error: undefined, message: "TLS failed" }).message, /TLS failed/)
	})
	it("retains close code, reason and clean-close state", () => {
		const error = responsesWebsocketCloseError("Stream closed", { code: 1011, reason: "server timeout", wasClean: false })
		assert.equal(error.code, "websocket_closed")
		assert.equal(error.closeCode, 1011)
		assert.equal(error.closeReason, "server timeout")
		assert.equal(error.wasClean, false)
		assert.match(error.message, /1011.*server timeout/)
	})
})
