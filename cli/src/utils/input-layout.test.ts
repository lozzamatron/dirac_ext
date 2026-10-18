import { describe, expect, it } from "vitest"
import { moveCursorDown, moveCursorUp } from "./cursor"
import { getInputContentWidth, getInputCursorRow, getInputVisualRows } from "./input-layout"
import { createInputViewport } from "./input-viewport"

describe("input visual-row layout", () => {
	it("accounts for borders, clipping indicators and the prompt label", () => {
		expect(getInputContentWidth(80)).toBe(74)
		expect(getInputContentWidth(80, "(steer Goal)")).toBe(61)
	})

	it("reserves a cursor cell and hard-wraps without changing draft offsets or spaces", () => {
		const text = "abc def ghij"
		const rows = getInputVisualRows(text, 5)
		expect(rows.map((row) => text.slice(row.start, row.end))).toEqual(["abc ", "def ", "ghij"])
		expect(getInputCursorRow(rows, 4)).toBe(1)
		expect(getInputCursorRow(rows, text.length)).toBe(2)
	})

	it.each(["abcd\nnext", "\nnext", "abcd\n", "\n\n", ""])("retains empty rows without double-wrapping newlines: %j", (text) => {
		const rows = getInputVisualRows(text, 5)
		expect(rows.map((row) => text.slice(row.start, row.end))).toEqual(text.split("\n"))
	})

	it("measures wide and combined graphemes as terminal cells", () => {
		const text = "a界e\u0301🙂b"
		const rows = getInputVisualRows(text, 5)
		expect(rows.map((row) => text.slice(row.start, row.end))).toEqual(["a界e\u0301", "🙂b"])
		expect(rows[0].cursorStops).toEqual([
			{ index: 0, column: 0 },
			{ index: 1, column: 1 },
			{ index: 2, column: 3 },
		])
		expect(rows[1].cursorStops).toEqual([
			{ index: 4, column: 0 },
			{ index: 6, column: 2 },
			{ index: 7, column: 3 },
		])
	})

	it("keeps the end cursor inside the row budget for wrapped prose", () => {
		const text = Array.from({ length: 120 }, (_, index) => `word${index}`).join(" ")
		const viewport = createInputViewport(text, text.length, 74, 10)
		expect(viewport.hasHiddenBefore).toBe(true)
		expect(viewport.hasHiddenAfter).toBe(false)
		expect(getInputVisualRows(viewport.text, 74)).toHaveLength(10)
		expect(viewport.text.endsWith("word119")).toBe(true)
		expect(viewport.cursorPosition).toBe(viewport.text.length)
	})
})

describe("vertical cursor movement", () => {
	it("moves by rendered rows in a paragraph, without requiring Ctrl+A", () => {
		const text = "abcdefghijklmnop"
		expect(moveCursorUp(text, text.length, 5)).toBe(11)
		expect(moveCursorUp(text, 11, 5)).toBe(7)
		expect(moveCursorDown(text, 7, 5)).toBe(11)
	})

	it("handles hard and soft line breaks together", () => {
		const text = "abcdefgh\nijklm\nno"
		expect(moveCursorUp(text, text.length, 5)).toBe(14)
		expect(moveCursorUp(text, 14, 5)).toBe(10)
		expect(moveCursorUp(text, 10, 5)).toBe(5)
		expect(moveCursorDown(text, 5, 5)).toBe(10)
	})

	it("reaches blank first and trailing rows", () => {
		expect(moveCursorUp("\nsecond", 3, 80)).toBe(0)
		expect(moveCursorDown("first\n", 2, 80)).toBe(6)
		expect(moveCursorUp("first\n", 6, 80)).toBe(0)
	})

	it("preserves cell columns rather than splitting emoji or combining characters", () => {
		const text = "abc\n界🙂e\u0301"
		expect(moveCursorDown(text, 3, 80)).toBe(5)
		expect(moveCursorUp(text, 7, 80)).toBe(3)
	})

	it("uses the new width after a resize", () => {
		const text = "abcdefghijklmnop"
		expect(moveCursorUp(text, 10, 5)).toBe(6)
		expect(moveCursorUp(text, 10, 9)).toBe(2)
	})
})
