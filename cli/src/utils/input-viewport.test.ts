import { describe, expect, it } from "vitest"
import { createInputViewport } from "./input-viewport"

describe("createInputViewport", () => {
	it("returns short input unchanged", () => {
		expect(createInputViewport("hello", 2, 10, 3)).toEqual({
			text: "hello",
			cursorPosition: 2,
			hasHiddenBefore: false,
			hasHiddenAfter: false,
		})
	})

	it("keeps an early cursor visible instead of always showing the draft tail", () => {
		const text = "0000\n1111\n2222\n3333\n4444"
		const viewport = createInputViewport(text, "0000\n11".length, 20, 3)

		expect(viewport.text).toBe("0000\n1111\n2222")
		expect(viewport.cursorPosition).toBe("0000\n11".length)
		expect(viewport.hasHiddenBefore).toBe(false)
		expect(viewport.hasHiddenAfter).toBe(true)
	})

	it("centers a middle cursor and reports clipping on both sides", () => {
		const text = "0\n1\n2\n3\n4\n5\n6"
		const viewport = createInputViewport(text, "0\n1\n2\n3".length, 20, 3)

		expect(viewport.text).toBe("2\n3\n4")
		expect(viewport.cursorPosition).toBe("2\n3".length)
		expect(viewport.hasHiddenBefore).toBe(true)
		expect(viewport.hasHiddenAfter).toBe(true)
	})

	it("tracks soft-wrapped visual rows", () => {
		const viewport = createInputViewport("abcdefghijklmnop", 9, 5, 2)

		expect(viewport.text).toBe("efghijkl")
		expect(viewport.cursorPosition).toBe(5)
		expect(viewport.hasHiddenBefore).toBe(true)
		expect(viewport.hasHiddenAfter).toBe(true)
	})

	it("clamps an invalid cursor position", () => {
		expect(createInputViewport("hello", 99, 10, 2).cursorPosition).toBe(5)
	})
})
