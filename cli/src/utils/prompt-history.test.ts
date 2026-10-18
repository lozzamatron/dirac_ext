import { describe, expect, it } from "vitest"
import { DiracMessageType, type DiracMessage } from "@shared/ExtensionMessage"
import { getRecentUniquePrompts, getUserPrompts } from "@shared/messages/prompt-history"

function message(text: string, ts: number, role: "user" | "assistant" = "user"): DiracMessage {
	return { id: `${ts}`, ts, content: { type: DiracMessageType.MARKDOWN, content: text, role, images: ["old-image.png"] } }
}

describe("prompt history", () => {
	it("extracts only nonempty human transcript text without attachments", () => {
		expect(
			getUserPrompts([
				message("initial", 1),
				message("assistant", 2, "assistant"),
				message("follow-up\n😀", 3),
				message("   ", 4),
				{ id: "checkpoint", ts: 5, content: { type: DiracMessageType.CHECKPOINT } },
			]),
		).toEqual([
			{ text: "initial", ts: 1 },
			{ text: "follow-up\n😀", ts: 3 },
		])
	})

	it("uses submission timestamps, suppresses duplicates, and bounds history after deduplication", () => {
		expect(
			getRecentUniquePrompts(
				[
					{ text: "old", ts: 1 },
					{ text: "repeat", ts: 2 },
					{ text: "new", ts: 3 },
					{ text: "repeat", ts: 4 },
				],
				2,
			),
		).toEqual(["repeat", "new"])
	})
})
