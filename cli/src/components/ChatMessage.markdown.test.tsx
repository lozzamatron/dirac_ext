import { DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"
import { render } from "ink-testing-library"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { ChatMessage } from "./ChatMessage"
import { Markdown } from "./modular-ui/Markdown"
import { theme } from "../constants/theme"
import { CardBody } from "./modular-ui/CardBody"
import { clipMarkdownLines, renderMarkdownLines } from "../utils/markdown"
import { estimateTimelineMessageBodyRows } from "../utils/timeline-rows"
import { createDynamicTimelineItems } from "../hooks/useChatTimeline"

vi.mock("../hooks/useTerminalSize", () => ({
	useTerminalSize: () => ({
		columns: 120,
		rows: 40,
		resizeKey: 0,
	}),
}))

describe("ChatMessage markdown rendering", () => {
	it("renders basic markdown elements correctly with appropriate styling", () => {
		const message: DiracMessage = {
			id: "1",
			ts: Date.now(),
			content: {
				type: DiracMessageType.MARKDOWN,
				content:
					"# Heading 1\n\nThis is a **bold** and *italic* text with `inline code`.\n\n- List item 1\n- List item 2\n\n> Blockquote\n\n```javascript\nconst x = 1;\n```",
			},
		}

		const { lastFrame } = render(React.createElement(ChatMessage, { message, mode: "act" }))
		const frame = lastFrame() || ""
		const plainFrame = frame.replace(/\u001B\[[0-9;]*m/g, "")

		expect(plainFrame).toContain("Heading 1")
		expect(plainFrame).toContain("bold")
		expect(plainFrame).toContain("italic")
		expect(plainFrame).toContain("inline code")
		expect(plainFrame).toContain("• List item 1")
		expect(plainFrame).toContain("• List item 2")
		expect(plainFrame).toContain("│ Blockquote")
		expect(plainFrame).toContain("const x = 1;")

		expect(frame).toContain("\u001B[1m")
		expect(frame).toContain("\u001B[3m")
		const codeBackgroundRgb = theme.codeBg
			.slice(1)
			.match(/.{2}/g)!
			.map((component) => Number.parseInt(component, 16))
			.join(";")
		expect(frame).toContain(`\u001B[48;2;${codeBackgroundRgb}m`)
	})

	it("#264: keeps code literal in a live thinking tail after its opening fence is clipped", () => {
		const message: DiracMessage = {
			id: "thinking-code",
			ts: 0,
			content: {
				type: DiracMessageType.MARKDOWN,
				isReasoning: true,
				content: "```text\nfirst\nsecond\nthird\n**literal tail**",
			},
		}
		const view = render(<ChatMessage message={message} />)
		const plain = (view.lastFrame() ?? "").replace(/\u001B\[[0-9;]*m/g, "")
		expect(plain).toContain("│ **literal tail**")
		expect(plain).not.toContain("first")
		view.unmount()
	})

	it("#265: formats bounded completion cards before clipping", () => {
		const view = render(<CardBody body={"## Commands\n\n**Read-only** with `ls`\n\n- Inspect files"} renderType="markdown" maxLines={20} renderWidth={30} />)
		const frame = view.lastFrame() ?? ""
		const plain = frame.replace(/\u001B\[[0-9;]*m/g, "")
		expect(plain).toContain("Commands")
		expect(plain).toContain("• Inspect files")
		expect(plain).not.toMatch(/##|\*\*|`/)
		expect(frame).toContain("\u001B[1m")
		view.unmount()
	})

	it.each([false, true])("#265: preserves fenced code in bounded Markdown (tailOnly=%s)", (tailOnly) => {
		const message: DiracMessage = {
			id: "bounded-code", ts: 0,
			content: { type: DiracMessageType.MARKDOWN, content: "```text\nfirst\nsecond\nthird\n**literal tail**\n```" },
		}
		const view = render(<ChatMessage message={message} maxContentLines={2} tailOnly={tailOnly} />)
		const plain = (view.lastFrame() ?? "").replace(/\u001B\[[0-9;]*m/g, "")
		expect(plain).toContain("│ **literal tail** │")
		expect(plain).not.toContain("```")
		view.unmount()
	})

	it("#265: preserves Markdown in projected card tails", () => {
		const message: DiracMessage = {
			id: "card-tail", ts: 0,
			content: {
				type: DiracMessageType.CARD, card: {
					id: "card-tail", header: "Response", status: "success" as any, renderType: "markdown",
					body: "```text\nfirst\n**literal tail**\n```",
				}
			},
		}
		const view = render(<ChatMessage message={message} maxContentLines={2} tailOnly />)
		const plain = (view.lastFrame() ?? "").replace(/\u001B\[[0-9;]*m/g, "")
		expect(plain).toContain("│ **literal tail** │")
		view.unmount()
	})

	it.each([DiracMessageType.MARKDOWN, DiracMessageType.CARD])("#265: scroll bounds count formatted rows for %s", (type) => {
		const body = "## Commands\n\n1. Review **commands**.\n2. Ask first.\n\n```text\n**literal**\n```\n\n[Docs][ref]\n\n[ref]: https://example.com/docs"
		const message: DiracMessage = {
			id: "row-count", ts: 0, content: type === DiracMessageType.CARD
				? { type, card: { id: "row-count", header: "Response", status: "success" as any, renderType: "markdown", body } }
				: { type: DiracMessageType.MARKDOWN, content: body }
		}
		const width = 30 - (type === DiracMessageType.CARD ? 6 : 4)
		const rows = renderMarkdownLines(body, width)
		expect(estimateTimelineMessageBodyRows(message, 30)).toBe(rows.length)
		const layout = { liveViewportRows: 8, activeContentRows: 6, compactHistoryRows: 0 }
		const plan = createDynamicTimelineItems([message], undefined, layout, 30, 0, () => false)
		const item = plan.items[0]
		if (item.type !== "message") throw new Error("Expected message")
		expect(clipMarkdownLines(rows, item.maxContentLines!, item.scrollOffset).visibleText).toBe(rows.slice(0, item.maxContentLines).join("\n"))
	})

	it("keeps tables and code blocks within an explicit narrow width", () => {
		const { lastFrame } = render(
			<Markdown width={10}>{"| Long heading | Other |\n| --- | --- |\n| Long cell value | More content |\n\n```\nabcdefghijklmnop\n```"}</Markdown>,
		)
		const plainFrame = (lastFrame() || "").replace(/\u001B\[[0-9;]*m/g, "")
		for (const line of plainFrame.split("\n")) expect(line.length).toBeLessThanOrEqual(10)
		expect(plainFrame).toContain("…")
	})
})
