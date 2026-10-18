import { Text, type Key } from "ink"
import { render } from "ink-testing-library"
// biome-ignore lint/correctness/noUnusedImports: React is needed by the test JSX runtime.
import React from "react"
import { beforeEach, expect, it, vi } from "vitest"
import { DiracMessageType } from "@shared/ExtensionMessage"
import { useComposer } from "./useComposer"
import { useChatInputHandler } from "./useChatInputHandler"
import { useRawBackspaceKeys } from "./useRawBackspaceKeys"
import { useHomeEndKeys } from "./useHomeEndKeys"

const vimSetting = vi.hoisted(() => ({ enabled: true, listeners: new Set<() => void>() }))

vi.mock("@/core/controller/slash/getAvailableSlashCommands", () => ({
	getAvailableSlashCommands: vi.fn().mockResolvedValue({ commands: [] }),
}))
vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: () => ({
			getGlobalSettingsKey: () => vimSetting.enabled,
			subscribe: (listener: () => void) => {
				vimSetting.listeners.add(listener)
				return () => vimSetting.listeners.delete(listener)
			},
		}),
	},
}))
vi.mock("./useHomeEndKeys", () => ({ useHomeEndKeys: vi.fn() }))
vi.mock("./useRawBackspaceKeys", () => ({ useRawBackspaceKeys: vi.fn() }))
vi.mock("./useChatInputHandler", () => ({ useChatInputHandler: vi.fn() }))

beforeEach(() => {
	vimSetting.enabled = true
	vi.clearAllMocks()
})

type Composer = ReturnType<typeof useComposer>
let latest: Composer
const delay = () => new Promise((resolve) => setTimeout(resolve, 20))

function inputHandlers() {
	return vi.mocked(useChatInputHandler).mock.lastCall![0]
}

function vimInput(input = "", key: Partial<Key> = {}) {
	return inputHandlers().handleVimInput!(input, key as Key)
}

function Harness({ controller }: { controller: { task?: { taskId: string } } }) {
	latest = useComposer({
		ctrl: Object.assign(controller, { getPromptHistory: async () => [] }),
		messages: [{ id: "old", ts: 1, content: { type: DiracMessageType.MARKDOWN, role: "user", content: "historical prompt" } }],
		mode: "act",
		workspacePath: "/workspace",
		inputColumns: 70,
		activePanel: null,
		setActivePanel: vi.fn(),
		isSpinnerActive: false,
		isProcessing: false,
		uiActionState: {},
		yolo: false,
		pendingAsk: null,
		actionsRef: { current: {} as never },
		isYoloSuppressed: () => false,
		isEmptyConversation: false,
		scrollableCardMaxOffset: 0,
		cardScrollOffset: 0,
		setCardScrollOffset: vi.fn(),
		handleGoalControl: vi.fn(),
		toggleGoalDetails: vi.fn(),
		disarmGoalStopConfirmation: vi.fn(),
	})
	return (
		<Text>
			{latest.storageKey}: {latest.textInput}
		</Text>
	)
}

it("tracks task creation on an unchanged controller and restores a follow-up after resize remount", async () => {
	const controller: { task?: { taskId: string } } = {}
	let app = render(<Harness controller={controller} />)
	await delay()
	controller.task = { taskId: "vim-resize-task" }
	app.rerender(<Harness controller={controller} />)
	await delay()
	expect(latest.storageKey).toBe("vim-resize-task")
	latest.setTextInput("follow-up draft")
	await delay()
	app.unmount()
	app = render(<Harness controller={controller} />)
	await delay()
	expect(latest.textInput).toBe("follow-up draft")
	app.unmount()
})

it.each([
	1, 2,
])("multiplies a pending Vim count by %i raw Delete/Backspace events without concatenating digits", async (count) => {
	const controller = { task: { taskId: `vim-raw-count-${count}` } }
	const app = render(<Harness controller={controller} />)
	await delay()
	latest.setTextInput("abcdef")
	await delay()
	vimInput("", { escape: true })
	await delay()
	vimInput("2")
	vi.mocked(useRawBackspaceKeys).mock.lastCall![0].onBackspace(count)
	await delay()
	expect(latest.textInput).toBe("abcdef")
	expect(latest.cursorPos).toBe(5 - 2 * count)
	vimInput("02")
	vi.mocked(useRawBackspaceKeys).mock.lastCall![0].onDelete!(count)
	await delay()
	expect(latest.textInput).toBe("abcdef".slice(2 * count))
	vimInput("u")
	await delay()
	expect(latest.textInput).toBe("abcdef")
	app.unmount()
})

it.each(["u", "k", "w"])("undoes and redoes Ctrl+%s deletion in NORMAL", async (key) => {
	const controller = { task: { taskId: `vim-ctrl-undo-${key}` } }
	const app = render(<Harness controller={controller} />)
	await delay()
	latest.setTextInput("abc")
	await delay()
	vimInput("", { escape: true })
	await delay()
	expect(vimInput(key, { ctrl: true })).toBe(false)
	expect(inputHandlers().handleCtrlShortcut(key)).toBe(true)
	await delay()
	const deleted = latest.textInput
	expect(deleted).not.toBe("abc")
	vimInput("u")
	await delay()
	expect(latest.textInput).toBe("abc")
	expect(latest.cursorPos).toBe(2)
	vimInput("r", { ctrl: true })
	await delay()
	expect(latest.textInput).toBe(deleted)
	expect(latest.vimMode).toBe("normal")
	app.unmount()
})

it("records NORMAL newline edits and clears redo when editing after undo", async () => {
	const controller = { task: { taskId: "vim-newline-undo" } }
	const app = render(<Harness controller={controller} />)
	await delay()
	latest.setTextInput("abc")
	await delay()
	vimInput("", { escape: true })
	await delay()
	inputHandlers().insertTextAtCursor("\n")
	await delay()
	expect(latest.textInput).toBe("ab\nc")
	vimInput("u")
	await delay()
	expect(latest.textInput).toBe("abc")
	vimInput("r", { ctrl: true })
	await delay()
	expect(latest.textInput).toBe("ab\nc")
	vimInput("u")
	inputHandlers().insertTextAtCursor("!")
	vimInput("r", { ctrl: true })
	await delay()
	expect(latest.textInput).toBe("ab!c")
	expect(latest.vimMode).toBe("normal")
	app.unmount()
})

it("keeps task drafts and undo histories isolated while switching tasks and remounting", async () => {
	const controller = { task: { taskId: "vim-isolation-first" } }
	let app = render(<Harness controller={controller} />)
	await delay()
	latest.setTextInput("first draft")
	await delay()
	vimInput("", { escape: true })
	await delay()
	controller.task = { taskId: "vim-isolation-second" }
	app.rerender(<Harness controller={controller} />)
	await delay()
	expect(latest.textInput).toBe("")
	expect(latest.vimMode).toBe("insert")
	latest.setTextInput("second draft")
	await delay()
	vimInput("", { escape: true })
	vimInput("u")
	await delay()
	expect(latest.textInput).toBe("")
	vimInput("r", { ctrl: true })
	await delay()
	expect(latest.textInput).toBe("second draft")
	controller.task = { taskId: "vim-isolation-first" }
	app.rerender(<Harness controller={controller} />)
	await delay()
	expect(latest.textInput).toBe("first draft")
	expect(latest.vimMode).toBe("normal")
	expect(latest.cursorPos).toBe(10)
	app.unmount()
	app = render(<Harness controller={controller} />)
	await delay()
	expect(latest.textInput).toBe("first draft")
	expect(latest.vimMode).toBe("normal")
	expect(latest.cursorPos).toBe(10)
	vimInput("u")
	await delay()
	expect(latest.textInput).toBe("")
	app.unmount()
})

it.each([false, true])("preserves ordinary editing with Vim disabled (previously enabled: %s)", async (wasEnabled) => {
	vimSetting.enabled = wasEnabled
	const controller = { task: { taskId: `vim-disabled-${wasEnabled}` } }
	const app = render(<Harness controller={controller} />)
	await delay()
	latest.setTextInput("draft")
	await delay()
	if (wasEnabled) {
		vimInput("", { escape: true })
		await delay()
		expect(latest.vimMode).toBe("normal")
		vimSetting.enabled = false
		for (const listener of vimSetting.listeners) listener()
		await delay()
		expect(latest.textInput).toBe("draft")
	}
	expect(latest.vimMode).toBeUndefined()
	latest.setTextInput("abc")
	await delay()
	expect(latest.cursorPos).toBe(3)
	expect(vimInput("", { escape: true })).toBe(false)
	expect(vimInput("2dw")).toBe(false)
	inputHandlers().insertTextAtCursor("2dw")
	await delay()
	expect(latest.textInput).toBe("abc2dw")
	vi.mocked(useHomeEndKeys).mock.lastCall![0].onHome()
	await delay()
	expect(latest.cursorPos).toBe(0)
	vi.mocked(useHomeEndKeys).mock.lastCall![0].onEnd()
	vi.mocked(useRawBackspaceKeys).mock.lastCall![0].onBackspace(2)
	await delay()
	expect(latest.textInput).toBe("abc2")
	expect(latest.cursorPos).toBe(4)
	latest.setCursorPos(1)
	vi.mocked(useRawBackspaceKeys).mock.lastCall![0].onDelete!(1)
	await delay()
	expect(latest.textInput).toBe("ac2")
	expect(latest.cursorPos).toBe(1)
	expect(inputHandlers().handleCtrlShortcut("e")).toBe(true)
	expect(inputHandlers().handleCtrlShortcut("w")).toBe(true)
	inputHandlers().insertTextAtCursor("first\r\n界🙂\r\nlast")
	await delay()
	expect(latest.textInput).toBe("first\n界🙂\nlast")
	expect(latest.cursorPos).toBe(latest.textInput.length)
	vi.mocked(useHomeEndKeys).mock.lastCall![0].onHome()
	await delay()
	expect(latest.cursorPos).toBe(0)
	vi.mocked(useHomeEndKeys).mock.lastCall![0].onEnd()
	await delay()
	expect(latest.cursorPos).toBe(latest.textInput.length)
	expect(inputHandlers().handleCtrlShortcut("a")).toBe(true)
	expect(inputHandlers().handleCtrlShortcut("k")).toBe(true)
	inputHandlers().insertTextAtCursor("prefix suffix")
	latest.setCursorPos(7)
	expect(inputHandlers().handleCtrlShortcut("u")).toBe(true)
	await delay()
	expect(latest.textInput).toBe("suffix")
	expect(latest.cursorPos).toBe(0)
	latest.resetInput()
	await delay()
	expect(latest.textInput).toBe("")
	expect(latest.cursorPos).toBe(0)
	expect(latest.vimMode).toBeUndefined()
	app.unmount()
})
it("recall restores collapsed paste data, cursor, and Vim state without losing payloads", async () => {
	const app = render(<Harness controller={{ task: { taskId: "history-paste" } }} />)
	await delay()
	const pastedTexts = new Map([[1, "the full pasted content"]])
	inputHandlers().setPastedTexts(pastedTexts)
	latest.setTextInput("draft [Pasted text #1 +2 lines] suffix")
	latest.setCursorPos(6)
	await delay()
	inputHandlers().navigateHistory("older")
	await delay()
	expect(latest.textInput).toBe("historical prompt")
	expect(latest.pastedTexts.size).toBe(0)
	inputHandlers().navigateHistory("newer")
	await delay()
	expect(latest.textInput).toBe("draft [Pasted text #1 +2 lines] suffix")
	expect(latest.cursorPos).toBe(6)
	expect(latest.pastedTexts).toEqual(pastedTexts)
	expect(latest.vimMode).toBe("insert")
	app.unmount()
})

it.each([false, true])("local-command resets discard stale browsing with Vim enabled: %s", async (enabled) => {
	vimSetting.enabled = enabled
	const app = render(<Harness controller={{ task: { taskId: `history-local-reset-${enabled}` } }} />)
	await delay()
	latest.setTextInput("draft before command")
	await delay()
	inputHandlers().navigateHistory("older")
	await delay()
	expect(latest.textInput).toBe("historical prompt")
	latest.setTextInput("/quiet")
	await delay()
	inputHandlers().resetInput()
	await delay()
	expect(latest.textInput).toBe("")
	latest.setTextInput("draft after command")
	latest.setCursorPos(5)
	await delay()
	inputHandlers().navigateHistory("older")
	await delay()
	expect(latest.textInput).toBe("historical prompt")
	inputHandlers().navigateHistory("newer")
	await delay()
	expect(latest.textInput).toBe("draft after command")
	expect(latest.cursorPos).toBe(5)
	app.unmount()
})
