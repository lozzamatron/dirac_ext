import { DiracMessageType, type DiracMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { createDynamicTimelineItems } from "./useChatTimeline"
import { clipTextToWindow } from "../utils/text-clipping"

const message = {
	id: "long-card",
	ts: 1,
	content: {
		type: DiracMessageType.CARD,
		card: {
			id: "long-card",
			header: "Long card",
			status: "success" as any,
			renderType: "text",
			body: Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"),
		},
	},
} satisfies DiracMessage

const layoutRows = {
	liveViewportRows: 6,
	activeContentRows: 3,
	compactHistoryRows: 2,
}

describe("createDynamicTimelineItems top-anchored scrolling", () => {
	const project = (cardMessage: DiracMessage = message, scrollFromTop = 0, columns = 80) => {
		const plan = createDynamicTimelineItems([cardMessage], undefined, layoutRows, columns, scrollFromTop, () => false)
		const item = plan.items[0]
		expect(item.type).toBe("message")
		if (item.type !== "message" || cardMessage.content.type !== DiracMessageType.CARD) throw new Error("Expected card")
		return clipTextToWindow(cardMessage.content.card.body!, item.maxContentLines!, columns - 6, item.scrollOffset).visibleText
	}

	it("starts at the first row and scrolls down to later rows", () => {
		expect(project()).toBe("line 0")
		expect(project(message, 4)).toBe("…line 4")
	})

	it("keeps the beginning visible as the body grows", () => {
		const growing: DiracMessage = {
			...message,
			content: { type: DiracMessageType.CARD, card: { ...message.content.card, body: "line 0\n" + "later\n".repeat(40) } },
		}
		expect(project(growing)).toBe(project())
	})

	it("keeps the top visible when narrower widths add wrapped rows", () => {
		expect(project(message, 0, 8)).toBe("li")
	})

	it("clamps scrolling at the end", () => {
		expect(project(message, 100)).toBe("…line 19")
	})
})

describe("createDynamicTimelineItems card suppression", () => {
	it("does not allocate body rows or scrolling for a suppressed card", () => {
		const plan = createDynamicTimelineItems([message], undefined, layoutRows, 80, 0, () => true)
		const item = plan.items[0]

		expect(plan.maxScrollOffset).toBe(0)
		expect(item.type).toBe("message")
		if (item.type === "message") expect(item.maxContentLines).toBeUndefined()
	})

	it("allocates scrolling for the same card when its body is visible", () => {
		const plan = createDynamicTimelineItems([message], undefined, layoutRows, 80, 0, () => false)
		expect(plan.maxScrollOffset).toBeGreaterThan(0)
	})
})
