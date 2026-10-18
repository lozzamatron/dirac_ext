import { getInputCursorRow, getInputVisualRows } from "./input-layout"

function moveCursorVertically(text: string, cursorPos: number, columns: number, direction: -1 | 1): number {
	const rows = getInputVisualRows(text, columns)
	const rowIndex = getInputCursorRow(rows, cursorPos)
	const targetRowIndex = rowIndex + direction
	if (targetRowIndex < 0) return 0
	if (targetRowIndex >= rows.length) return text.length

	const currentColumn = rows[rowIndex].cursorStops.reduce((column, stop) => (stop.index <= cursorPos ? stop.column : column), 0)
	const targetRow = rows[targetRowIndex]
	return targetRow.cursorStops.reduce((index, stop) => (stop.column <= currentColumn ? stop.index : index), targetRow.start)
}

/** Move up one rendered input row, preserving the terminal column when possible. */
export function moveCursorUp(text: string, cursorPos: number, columns: number): number {
	return moveCursorVertically(text, cursorPos, columns, -1)
}

/** Move down one rendered input row, preserving the terminal column when possible. */
export function moveCursorDown(text: string, cursorPos: number, columns: number): number {
	return moveCursorVertically(text, cursorPos, columns, 1)
}
