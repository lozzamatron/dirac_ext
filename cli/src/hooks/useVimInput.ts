import type { Key } from "ink"
import { useCallback, useEffect, useRef, useState } from "react"
import { applyVimKey, applyVimTextEdit, createVimEditor, type VimEditorState, type VimSnapshot } from "../utils/vim-editor"

interface UseVimInputProps {
	enabled: boolean
	getText: () => string
	getCursorPos: () => number
	setValue: (value: VimSnapshot) => void
}

export function useVimInput({ enabled, getText, getCursorPos, setValue }: UseVimInputProps) {
	const [editor, setEditor] = useState(() => createVimEditor({ text: getText(), cursorPos: getCursorPos() }))
	const editorRef = useRef(editor)

	const updateEditor = useCallback((next: VimEditorState) => {
		editorRef.current = next
		setEditor(next)
	}, [])

	useEffect(() => {
		updateEditor(createVimEditor({ text: getText(), cursorPos: getCursorPos() }))
	}, [enabled, updateEditor, getText, getCursorPos])

	const restoreVimDraft = useCallback(
		(value: VimSnapshot, savedState?: VimEditorState) => {
			updateEditor(savedState ? { ...savedState, ...value } : createVimEditor(value))
			setValue(value)
		},
		[updateEditor, setValue],
	)

	const resetVimInput = useCallback(() => {
		restoreVimDraft({ text: "", cursorPos: 0 })
	}, [restoreVimDraft])

	const editWithVimHistory = useCallback(
		<T>(edit: () => T): T => {
			const before = { ...editorRef.current, text: getText(), cursorPos: getCursorPos() }
			const result = edit()
			if (enabled && before.mode === "normal") {
				const next = applyVimTextEdit(before, { text: getText(), cursorPos: getCursorPos() })
				updateEditor(next)
				setValue(next)
			}
			return result
		},
		[enabled, getText, getCursorPos, updateEditor, setValue],
	)

	const handleVimInput = useCallback(
		(input: string, key: Partial<Key>, repetitions = 1): boolean => {
			if (!enabled) return false
			const current = { ...editorRef.current, text: getText(), cursorPos: getCursorPos() }
			if (key.escape) {
				const next = applyVimKey(current, "Escape")
				updateEditor(next)
				setValue(next)
				return true
			}
			if (current.mode === "insert") return false
			if (key.ctrl && input === "r") {
				const next = applyVimKey(current, "redo")
				updateEditor(next)
				setValue(next)
				return true
			}
			if (key.ctrl || key.meta || key.tab || key.return) {
				updateEditor({ ...current, count: "", operator: undefined, operatorCount: 1, pendingG: false })
				return false
			}
			// Empty-prompt arrows still scroll the transcript or navigate prompt history.
			if (!current.text && (key.upArrow || key.downArrow)) return false
			const command = key.leftArrow ? "h" : key.rightArrow ? "l" : key.upArrow ? "k" : key.downArrow ? "j" : input
			if (!command) return true
			let next = current
			for (const char of command) next = applyVimKey(next, char, repetitions)
			updateEditor(next)
			setValue(next)
			return true
		},
		[enabled, getText, getCursorPos, setValue, updateEditor],
	)

	return {
		vimState: editor,
		vimMode: enabled ? editor.mode : undefined,
		handleVimInput,
		resetVimInput,
		restoreVimDraft,
		editWithVimHistory,
	}
}
