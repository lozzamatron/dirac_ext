import assert from "node:assert/strict"
import type { DiracStorageMessage } from "@shared/messages/content"
import { describe, it } from "mocha"
import { goalTranscriptPage, MAX_TRANSCRIPT_PAGE_BYTES } from "../GoalTranscript"

function message(text: string): DiracStorageMessage {
	return { role: "user", content: [{ type: "text", text }], ts: 1 }
}

describe("Goal transcript byte budget", () => {
	it("pages normal messages without exceeding either limit", () => {
		const history = [message("a".repeat(20000)), message("b".repeat(20000)), message("last")]
		const first = goalTranscriptPage(history, undefined, 50)
		assert.deepEqual(first.entries, [history[0]])
		assert.equal(first.nextCursor, "1")
		const second = goalTranscriptPage(history, first.nextCursor, 1)
		assert.deepEqual(second.entries, [history[1]])
		assert.equal(second.nextCursor, "2")
		assert.deepEqual(goalTranscriptPage(history, second.nextCursor, 50).entries, [history[2]])
	})

	it("returns oversized Unicode and escaped messages losslessly through bounded fragments", () => {
		const history = [message('😀\n"\\'.repeat(40000)), message("next message")]
		let cursor: string | undefined
		let json = ""
		let pages = 0
		do {
			const page = goalTranscriptPage(history, cursor, 50)
			assert.ok(Buffer.byteLength(JSON.stringify(page)) <= MAX_TRANSCRIPT_PAGE_BYTES)
			assert.ok(++pages < 100)
			if (page.fragment) {
				assert.equal(page.fragment.messageIndex, 0)
				assert.equal(page.fragment.offset, json.length)
				json += page.fragment.json
			} else {
				assert.deepEqual(page.entries, [history[1]])
			}
			cursor = page.nextCursor
		} while (cursor)
		assert.deepEqual(JSON.parse(json), history[0])
	})

	it("rejects malformed and out-of-range cursors", () => {
		for (const cursor of ["-1", "1x", "0:bad", "9", "0:9999", "9007199254740992"]) {
			assert.throws(() => goalTranscriptPage([message("short")], cursor, 50), /cursor/)
		}
	})
})
