import { render } from "ink-testing-library"
// biome-ignore lint/correctness/noUnusedImports: Vitest transforms this test with the classic JSX runtime.
import React from "react"
import { expect, it, vi } from "vitest"
import { usePromptHistory } from "./usePromptHistory"

interface Draft {
	text: string
	cursorPos: number
	pastedTexts: Map<number, string>
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

function setup(
	loadHistory = vi.fn(async () => [
		{ text: "older", ts: 1 },
		{ text: "newest", ts: 3 },
	]),
) {
	let draft: Draft = { text: "my draft", cursorPos: 2, pastedTexts: new Map([[1, "expanded paste"]]) }
	const initial = draft
	const onError = vi.fn()
	let latest: ReturnType<typeof usePromptHistory>
	const props = {
		scopeKey: "first",
		loadHistory,
		currentPrompts: [
			{ text: "follow-up", ts: 4 },
			{ text: "newest", ts: 3 },
		],
		captureDraft: () => draft,
		restoreDraft: (value: Draft) => {
			draft = value
		},
		recallText: (text: string) => {
			draft = { text, cursorPos: text.length, pastedTexts: new Map() }
		},
		onError,
	}
	function Harness() {
		latest = usePromptHistory(props)
		return null
	}
	const app = render(<Harness />)
	return {
		app,
		initial,
		props,
		onError,
		loadHistory,
		get draft() {
			return draft
		},
		get history() {
			return latest!
		},
		setDraft(value: Draft) {
			draft = value
		},
		rerender() {
			app.rerender(<Harness />)
		},
	}
}

it("merges follow-ups newest-first, deduplicates, clamps, caches, and restores the complete draft", async () => {
	const state = setup()
	await settle()
	state.history.navigateHistory("newer")
	await settle()
	expect(state.draft).toBe(state.initial)
	for (const text of ["follow-up", "newest", "older", "older"]) {
		state.history.navigateHistory("older")
		await settle()
		expect(state.draft.text).toBe(text)
	}
	for (const text of ["newest", "follow-up", "my draft"]) {
		state.history.navigateHistory("newer")
		await settle()
		expect(state.draft.text).toBe(text)
	}
	expect(state.draft).toBe(state.initial)
	expect(state.draft.cursorPos).toBe(2)
	expect(state.draft.pastedTexts.get(1)).toBe("expanded paste")
	expect(state.loadHistory).toHaveBeenCalledTimes(1)
	state.app.unmount()
})

it("serializes rapid navigation and resets browsing after submission", async () => {
	const state = setup()
	await settle()
	state.history.navigateHistory("older")
	state.history.navigateHistory("older")
	state.history.navigateHistory("newer")
	await settle()
	expect(state.draft.text).toBe("follow-up")
	state.history.resetHistory()
	state.setDraft({ ...state.initial, text: "fresh draft" })
	state.history.navigateHistory("older")
	state.history.navigateHistory("newer")
	await settle()
	expect(state.draft.text).toBe("fresh draft")
	state.app.unmount()
})

it.each(["text", "cursor"] as const)("cancels all queued recall after a pending-load %s edit", async (edit) => {
	let resolve!: (value: { text: string; ts: number }[]) => void
	const state = setup(
		vi.fn(
			() =>
				new Promise((done) => {
					resolve = done
				}),
		),
	)
	await settle()
	state.history.navigateHistory("older")
	state.history.navigateHistory("older")
	await settle()
	const edited = {
		...state.initial,
		...(edit === "text" ? { text: "edited while loading" } : { cursorPos: 3 }),
	}
	state.setDraft(edited)
	resolve([{ text: "old", ts: 1 }])
	await settle()
	expect(state.draft).toBe(edited)
	state.history.navigateHistory("older")
	await settle()
	expect(state.draft.text).toBe("follow-up")
	state.history.navigateHistory("newer")
	await settle()
	expect(state.draft).toBe(edited)
	state.app.unmount()
})

it("does not overwrite edits or a different conversation while a history read is pending", async () => {
	let resolve!: (value: { text: string; ts: number }[]) => void
	const state = setup(
		vi.fn(
			() =>
				new Promise((done) => {
					resolve = done
				}),
		),
	)
	await settle()
	state.history.navigateHistory("older")
	await settle()
	state.setDraft({ ...state.initial, text: "edited while loading" })
	resolve([{ text: "old", ts: 1 }])
	await settle()
	expect(state.draft.text).toBe("edited while loading")
	state.props.scopeKey = "second"
	state.rerender()
	await settle()
	state.history.navigateHistory("older")
	await settle()
	state.history.resetHistory()
	state.setDraft({ ...state.initial, text: "another conversation" })
	resolve([{ text: "old", ts: 1 }])
	await settle()
	expect(state.draft.text).toBe("another conversation")
	state.app.unmount()
})

it("leaves the draft unchanged for empty history and exposes storage errors", async () => {
	const empty = setup(vi.fn(async () => []))
	empty.props.currentPrompts = []
	empty.history.navigateHistory("older")
	await settle()
	expect(empty.draft).toBe(empty.initial)
	empty.app.unmount()
	const error = new Error("unreadable history")
	const failed = setup(
		vi.fn(async () => {
			throw error
		}),
	)
	await settle()
	expect(failed.onError).toHaveBeenCalledWith(error)
	expect(failed.draft).toBe(failed.initial)
	failed.app.unmount()
})
