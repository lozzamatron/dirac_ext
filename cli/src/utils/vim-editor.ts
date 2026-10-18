// A deliberately bounded Vim subset for the prompt, independent of Ink and task execution.
export type VimMode = "insert" | "normal"
export interface VimSnapshot {
	text: string
	cursorPos: number
}
export interface VimEditorState extends VimSnapshot {
	mode: VimMode
	count: string
	operator?: "d" | "c"
	operatorCount: number
	pendingG: boolean
	undo: VimSnapshot[]
	redo: VimSnapshot[]
	insertStart: VimSnapshot
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const snapshot = ({ text, cursorPos }: VimSnapshot): VimSnapshot => ({ text, cursorPos })

export function createVimEditor(value: VimSnapshot, mode: VimMode = "insert"): VimEditorState {
	return { ...value, mode, count: "", operatorCount: 1, pendingG: false, undo: [], redo: [], insertStart: snapshot(value) }
}

/** Index graphemes once per command, so counted motions remain linear in draft length. */
class VimTextMotions {
	private offsets: number[]
	private indices: Map<number, number>

	constructor(private text: string) {
		this.offsets = [...graphemes.segment(text)].map((part) => part.index).concat(text.length)
		this.indices = new Map(this.offsets.map((offset, index) => [offset, index]))
	}

	previous(pos: number): number {
		return this.offsets[Math.max(0, this.indices.get(pos)! - 1)]
	}

	next(pos: number): number {
		return this.offsets[Math.min(this.offsets.length - 1, this.indices.get(pos)! + 1)]
	}

	lineStart(pos: number): number {
		return pos === 0 ? 0 : this.text.lastIndexOf("\n", pos - 1) + 1
	}

	lineEnd(pos: number): number {
		const end = this.text.indexOf("\n", pos)
		return end < 0 ? this.text.length : end
	}

	boundary(pos: number): number {
		if (this.indices.has(pos)) return pos
		let low = 0
		let high = this.offsets.length - 1
		while (low < high) {
			const middle = Math.ceil((low + high) / 2)
			if (this.offsets[middle] <= pos) low = middle
			else high = middle - 1
		}
		return this.offsets[low]
	}

	normalCursor(pos: number): number {
		const end = this.lineEnd(pos)
		const last = end > this.lineStart(pos) ? this.previous(end) : end
		return this.boundary(Math.min(pos, last))
	}

	wordClass(pos: number): number {
		const char = this.text.slice(pos, this.next(pos))
		if (!char || /\s/u.test(char)) return 0
		return /[\p{L}\p{N}_]/u.test(char) ? 1 : 2
	}

	wordMotion(pos: number, command: string): number {
		if (command === "b") {
			pos = this.previous(pos)
			while (pos > 0 && this.wordClass(pos) === 0) pos = this.previous(pos)
			const group = this.wordClass(pos)
			while (pos > 0 && this.wordClass(this.previous(pos)) === group) pos = this.previous(pos)
			return pos
		}
		if (command === "e") {
			pos = this.next(pos)
			while (pos < this.text.length && this.wordClass(pos) === 0) pos = this.next(pos)
			return this.wordEnd(pos)
		}
		const group = this.wordClass(pos)
		while (pos < this.text.length && this.wordClass(pos) === group) pos = this.next(pos)
		while (pos < this.text.length && this.wordClass(pos) === 0) pos = this.next(pos)
		return pos
	}

	wordEnd(pos: number): number {
		const group = this.wordClass(pos)
		while (this.next(pos) < this.text.length && this.wordClass(this.next(pos)) === group) pos = this.next(pos)
		return pos
	}

	private verticalMotion(pos: number, down: boolean): number {
		const start = this.lineStart(pos)
		const end = this.lineEnd(pos)
		const column = this.indices.get(pos)! - this.indices.get(start)!
		if ((down && end === this.text.length) || (!down && start === 0)) return pos
		const targetStart = down ? end + 1 : this.lineStart(start - 1)
		const targetEnd = this.lineEnd(targetStart)
		const targetIndex = Math.min(this.indices.get(targetStart)! + column, this.indices.get(targetEnd)!)
		return this.normalCursor(this.offsets[targetIndex])
	}

	motion(pos: number, command: string, count: number): number | undefined {
		if (command === "0") return this.lineStart(pos)
		if (command === "^") {
			const start = this.lineStart(pos)
			const first = this.text.slice(start, this.lineEnd(pos)).search(/\S/u)
			return start + Math.max(0, first)
		}
		if (command === "$") {
			for (let n = 1; n < count && this.lineEnd(pos) < this.text.length; n++) pos = this.lineEnd(pos) + 1
			return this.lineEnd(pos)
		}
		if (command === "G") return this.lineStart(this.text.length)
		if (!["h", "l", "j", "k", "w", "b", "e"].includes(command)) return undefined
		for (let n = 0; n < count; n++) {
			const before = pos
			if (command === "h") pos = Math.max(this.lineStart(pos), this.previous(pos))
			else if (command === "l") pos = Math.min(this.lineEnd(pos), this.next(pos))
			else if (command === "j" || command === "k") pos = this.verticalMotion(pos, command === "j")
			else pos = this.wordMotion(pos, command)
			if (pos === before) break
		}
		return pos
	}
}

export function normalCursor(text: string, pos: number): number {
	return new VimTextMotions(text).normalCursor(pos)
}

function clearCommand(state: VimEditorState): VimEditorState {
	return { ...state, count: "", operator: undefined, operatorCount: 1, pendingG: false }
}

function enterInsert(state: VimEditorState, cursorPos: number): VimEditorState {
	return { ...clearCommand(state), mode: "insert", cursorPos, insertStart: snapshot({ ...state, cursorPos }) }
}

function deleteRange(state: VimEditorState, start: number, end: number, change = false): VimEditorState {
	const text = state.text.slice(0, start) + state.text.slice(end)
	const edited = {
		...clearCommand(state),
		text,
		cursorPos: change ? start : normalCursor(text, start),
		undo: start === end ? state.undo : [...state.undo, snapshot(state)].slice(-100),
		redo: [],
	}
	return change ? { ...enterInsert(edited, start), undo: state.undo, insertStart: snapshot(state) } : edited
}

function restoreHistory(state: VimEditorState, redo: boolean): VimEditorState {
	const source = redo ? state.redo : state.undo
	const restored = source.at(-1)
	if (!restored) return clearCommand(state)
	return {
		...clearCommand(state),
		...restored,
		cursorPos: normalCursor(restored.text, restored.cursorPos),
		undo: redo ? [...state.undo, snapshot(state)] : source.slice(0, -1),
		redo: redo ? source.slice(0, -1) : [...state.redo, snapshot(state)],
	}
}

/** Commit a non-modal text mutation as one NORMAL-mode undo transaction. */
export function applyVimTextEdit(state: VimEditorState, value: VimSnapshot): VimEditorState {
	const changed = value.text !== state.text
	return {
		...clearCommand(state),
		...value,
		cursorPos: normalCursor(value.text, value.cursorPos),
		undo: changed ? [...state.undo, snapshot(state)].slice(-100) : state.undo,
		redo: changed ? [] : state.redo,
	}
}

/** One key, or a named Escape/redo action. Unknown normal-mode keys cancel pending commands. */
export function applyVimKey(state: VimEditorState, key: string, repetitions = 1): VimEditorState {
	const motions = new VimTextMotions(state.text)
	if (key === "Escape") {
		if (state.mode === "normal") return clearCommand(state)
		const changed = state.text !== state.insertStart.text
		return {
			...clearCommand(state),
			mode: "normal",
			cursorPos: motions.normalCursor(
				Math.max(motions.lineStart(state.cursorPos), motions.previous(motions.boundary(state.cursorPos))),
			),
			undo: changed ? [...state.undo, state.insertStart].slice(-100) : state.undo,
			redo: changed ? [] : state.redo,
		}
	}
	if (state.mode === "insert") {
		return {
			...state,
			text: state.text.slice(0, state.cursorPos) + key + state.text.slice(state.cursorPos),
			cursorPos: state.cursorPos + key.length,
		}
	}
	state = { ...state, cursorPos: motions.normalCursor(state.cursorPos) }
	if (/^[1-9]$/.test(key) || (key === "0" && state.count)) return { ...state, count: `${state.count}${key}`.slice(0, 6) }
	const count = (Number(state.count) || 1) * state.operatorCount * repetitions
	if (state.pendingG) {
		const cleared = clearCommand(state)
		return key === "g" ? { ...cleared, cursorPos: 0 } : cleared
	}
	if (!state.operator && key === "g") return { ...state, pendingG: true }
	if (!state.operator && (key === "d" || key === "c")) return { ...state, operator: key, operatorCount: count, count: "" }
	if (state.operator && key === state.operator) {
		let start = motions.lineStart(state.cursorPos)
		let end = start
		for (let n = 0; n < count; n++) {
			end = motions.lineEnd(end)
			if (end === state.text.length) break
			end++
		}
		if (state.operator === "c" && end > start && state.text[end - 1] === "\n") end--
		if (state.operator === "d" && end === state.text.length && start > 0 && (start === end || !state.text.endsWith("\n")))
			start--
		return deleteRange(state, start, end, state.operator === "c")
	}
	if (state.operator && !["h", "l", "w", "b", "e", "0", "^", "$"].includes(key)) return clearCommand(state)
	const changeWord = state.operator === "c" && key === "w" && motions.wordClass(state.cursorPos) !== 0
	let target = motions.motion(state.cursorPos, key, count)
	// cw changes through the current word's end, leaving following whitespace intact.
	if (changeWord) {
		target = motions.wordEnd(state.cursorPos)
		for (let n = 1; n < count && target < state.text.length; n++) {
			const before: number = target
			target = motions.wordEnd(motions.wordMotion(target, "w"))
			if (target === before) break
		}
	}
	if (target !== undefined) {
		if (!state.operator) return { ...clearCommand(state), cursorPos: motions.normalCursor(target) }
		if (key === "e" || changeWord) target = motions.next(target)
		return deleteRange(state, Math.min(state.cursorPos, target), Math.max(state.cursorPos, target), state.operator === "c")
	}
	if (state.operator) return clearCommand(state)
	if (key === "i") return enterInsert(state, state.cursorPos)
	if (key === "a") return enterInsert(state, Math.min(motions.lineEnd(state.cursorPos), motions.next(state.cursorPos)))
	if (key === "I") return enterInsert(state, motions.motion(state.cursorPos, "^", 1)!)
	if (key === "A") return enterInsert(state, motions.lineEnd(state.cursorPos))
	if (key === "x") {
		let end = state.cursorPos
		for (let n = 0; n < count && end < motions.lineEnd(state.cursorPos); n++) end = motions.next(end)
		return deleteRange(state, state.cursorPos, end)
	}
	if (key === "D" || key === "C")
		return deleteRange(state, state.cursorPos, motions.motion(state.cursorPos, "$", count)!, key === "C")
	if (key === "u" || key === "redo") {
		for (let n = 0; n < count; n++) {
			const before = state
			state = restoreHistory(state, key === "redo")
			if (state.text === before.text) break
		}
		return state
	}
	return clearCommand(state)
}
