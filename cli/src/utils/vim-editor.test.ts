import { describe, expect, it } from "vitest"
import { applyVimKey, createVimEditor, normalCursor, type VimEditorState } from "./vim-editor"

function edit(text: string, cursorPos: number, keys: string): VimEditorState {
	let state = createVimEditor({ text, cursorPos }, "normal")
	for (const key of keys) state = applyVimKey(state, key)
	return state
}

const words = "one two three four"

describe("Vim prompt editing", () => {
	it.each([
		[words, 17, "3b", 4],
		[words, 0, "2w", 8],
		[words, 0, "e", 2],
		[words, 2, "2e", 12],
		[words, 0, "$", 17],
		[words, 12, "0", 0],
		["  one two", 8, "^", 2],
		[words, 0, "99h", 0],
		[words, 17, "99l", 17],
		["a_b.foo,bar", 0, "w", 3],
		["a_b.foo,bar", 8, "b", 7],
		["\nabc\n", 0, "j", 1],
		["abc\nx\nlast", 2, "j", 4],
		["abc\nx\nlast", 4, "k", 0],
		["abc\nx\nlast", 0, "2j", 6],
		["abc\nx\nlast", 2, "G", 6],
		["abc\nx\nlast", 9, "gg", 0],
		["abc\nx\nlast", 0, "k", 0],
		["abc\nx\nlast", 9, "j", 9],
	])("moves %j from %i with %s to %i", (text, cursorPos, keys, expected) => {
		const state = edit(text, cursorPos, keys)
		expect(state.text).toBe(text)
		expect(state.cursorPos).toBe(expected)
		expect(state.mode).toBe("normal")
	})

	it.each([
		[words, 0, "d$", "", 0],
		[words, 4, "d$", "one ", 3],
		[words, 0, "dw", "two three four", 0],
		[words, 0, "2d2w", "", 0],
		[words, 0, "de", " two three four", 0],
		[words, 4, "db", "two three four", 0],
		[words, 4, "dh", "onetwo three four", 3],
		[words, 0, "dl", "ne two three four", 0],
		[words, 0, "3x", " two three four", 0],
		[words, 17, "99x", "one two three fou", 16],
		["one\ntwo\nthree", 4, "dd", "one\nthree", 4],
		["one\ntwo\nthree", 10, "dd", "one\ntwo", 6],
		["one\ntwo\n", 4, "dd", "one\n", 4],
		["one\n", 4, "dd", "one", 2],
		["one\ntwo\nthree", 0, "2dd", "three", 0],
		["one\ntwo", 0, "99dd", "", 0],
		["one\ntwo\nthree", 1, "d$", "o\ntwo\nthree", 0],
		["one\ntwo\nthree", 1, "D", "o\ntwo\nthree", 0],
	])("deletes %j from %i with %s", (text, cursorPos, keys, expected, expectedPos) => {
		const state = edit(text, cursorPos, keys)
		expect(state.text).toBe(expected)
		expect(state.cursorPos).toBe(expectedPos)
		expect(state.mode).toBe("normal")
	})

	it.each([
		[words, 0, "cw", " two three four", 0],
		[words, 2, "cw", "on two three four", 2],
		[words, 0, "2cw", " three four", 0],
		[words, 4, "c$", "one ", 4],
		[words, 4, "C", "one ", 4],
		["one\ntwo\nthree", 5, "cc", "one\n\nthree", 4],
		["one\ntwo\nthree", 0, "2cc", "\nthree", 0],
		["one\ntwo", 4, "cc", "one\n", 4],
	])("changes %j from %i with %s into INSERT", (text, cursorPos, keys, expected, expectedPos) => {
		const state = edit(text, cursorPos, keys)
		expect(state.text).toBe(expected)
		expect(state.cursorPos).toBe(expectedPos)
		expect(state.mode).toBe("insert")
	})

	it.each([
		["i", 3],
		["a", 4],
		["I", 2],
		["A", 5],
	])("%s enters INSERT at %i", (key, expected) => {
		const state = edit("  abc\ndef", 3, key)
		expect(state.cursorPos).toBe(expected)
		expect(state.mode).toBe("insert")
	})

	it("Esc exits INSERT one grapheme left, and clears incomplete commands", () => {
		let state = createVimEditor({ text: "hi 😀", cursorPos: 5 })
		state = applyVimKey(state, "Escape")
		expect(state.cursorPos).toBe(3)
		state = applyVimKey(state, "d")
		state = applyVimKey(state, "Escape")
		state = applyVimKey(state, "b")
		expect(state.text).toBe("hi 😀")
		expect(state.cursorPos).toBe(0)
	})

	it("handles empty input, blank lines, and all-whitespace input", () => {
		for (const text of ["", "\n", "\n\n", "  "]) {
			for (const keys of ["h", "l", "w", "b", "e", "x", "dw", "d$", "gg", "G", "999999b"]) {
				const state = edit(text, 0, keys)
				expect(state.cursorPos).toBeGreaterThanOrEqual(0)
				expect(state.cursorPos).toBeLessThanOrEqual(state.text.length)
			}
		}
	})

	it("never splits emoji, combining accents or ZWJ graphemes", () => {
		const text = "😀e\u0301👩‍💻界"
		expect(edit(text, 0, "l").cursorPos).toBe(2)
		expect(edit(text, 2, "l").cursorPos).toBe(4)
		expect(edit(text, 4, "x").text).toBe("😀e\u0301界")
		expect(edit(text, 0, "2x").text).toBe("👩‍💻界")
		expect(normalCursor(text, 3)).toBe(2)
	})

	it("undoes and redoes deletions and complete insert sessions", () => {
		let state = edit(words, 0, "dw")
		state = applyVimKey(state, "u")
		expect(state.text).toBe(words)
		state = applyVimKey(state, "redo")
		expect(state.text).toBe("two three four")
		state = applyVimKey(state, "i")
		for (const char of "new ") state = applyVimKey(state, char)
		state = applyVimKey(state, "Escape")
		state = applyVimKey(state, "u")
		expect(state.text).toBe("two three four")
		state = applyVimKey(state, "redo")
		expect(state.text).toBe("new two three four")
		state = applyVimKey(state, "x")
		expect(state.redo).toEqual([])
	})

	it("undoes a change and its inserted replacement as one edit", () => {
		let state = edit(words, 0, "cwNEW")
		state = applyVimKey(state, "Escape")
		state = applyVimKey(state, "u")
		expect(state.text).toBe(words)
		state = applyVimKey(state, "redo")
		expect(state.text).toBe("NEW two three four")
	})

	it.each([1, 2])("applies %i raw repetitions separately from pending command and operator counts", (repetitions) => {
		let state = edit("abcdef", 0, "2")
		state = applyVimKey(state, "x", repetitions)
		expect(state.text).toBe("abcdef".slice(2 * repetitions))
		state = edit("abcdef", 5, "2d")
		state = applyVimKey(state, "h", repetitions)
		expect(state.text).toBe("abcdef".slice(0, 5 - 2 * repetitions) + "f")
	})

	it("navigates a near-collapse-threshold draft with a large count", () => {
		const text = "word ".repeat(1900)
		const state = edit(text, 0, "999999w")
		expect(state.cursorPos).toBe(text.length - 1)
		expect(state.text).toBe(text)
	})

	it("unknown keys cancel pending operators and counts without inserting", () => {
		const state = edit(words, 0, "9dzl")
		expect(state.text).toBe(words)
		expect(state.cursorPos).toBe(1)
		expect(state.operator).toBeUndefined()
		expect(state.count).toBe("")
	})
})
