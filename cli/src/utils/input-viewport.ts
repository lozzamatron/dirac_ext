import { getInputCursorRow, getInputVisualRows } from "./input-layout"

export interface InputViewport {
	text: string
	cursorPosition: number
	hasHiddenBefore: boolean
	hasHiddenAfter: boolean
}

/** Select a cursor-centered window using the same visual rows as the renderer. */
export function createInputViewport(text: string, cursorPosition: number, columns: number, maxRows: number): InputViewport {
	const safeCursorPosition = Math.max(0, Math.min(text.length, cursorPosition))
	const rowBudget = Math.max(1, maxRows)
	const rows = getInputVisualRows(text, columns)

	if (rows.length <= rowBudget) {
		return {
			text,
			cursorPosition: safeCursorPosition,
			hasHiddenBefore: false,
			hasHiddenAfter: false,
		}
	}

	const cursorRow = getInputCursorRow(rows, safeCursorPosition)
	const rowsBeforeCursor = Math.floor(rowBudget / 2)
	const maximumStartRow = rows.length - rowBudget
	const startRow = Math.min(maximumStartRow, Math.max(0, cursorRow - rowsBeforeCursor))
	const endRow = startRow + rowBudget
	const sliceStart = rows[startRow].start
	const sliceEnd = rows[endRow - 1].end

	return {
		text: text.slice(sliceStart, sliceEnd),
		cursorPosition: safeCursorPosition - sliceStart,
		hasHiddenBefore: startRow > 0,
		hasHiddenAfter: endRow < rows.length,
	}
}
