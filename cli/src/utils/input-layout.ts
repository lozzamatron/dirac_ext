import stringWidth from "string-width"

interface CursorStop {
	index: number
	column: number
}

export interface InputVisualRow {
	start: number
	end: number
	cursorStops: CursorStop[]
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Border, padding and fixed one-column clipping indicators surround the input. */
export function getInputContentWidth(terminalColumns: number, inputPrompt = ""): number {
	const promptWidth = inputPrompt ? stringWidth(inputPrompt) + 1 : 0
	return Math.max(1, terminalColumns - 6 - promptWidth)
}

/**
 * Hard-wrap the draft by terminal cells, retaining offsets into the original text.
 * Reserve one cell for the painted cursor at a newline or the end of the draft.
 * Rendering, viewport clipping and vertical navigation must use these same rows.
 */
export function getInputVisualRows(text: string, columns: number): InputVisualRow[] {
	const width = Math.max(1, columns - 1)
	const rows: InputVisualRow[] = []
	let rowStart = 0
	let rowColumns = 0
	let cursorStops: CursorStop[] = []

	for (const { segment, index } of graphemes.segment(text)) {
		if (segment === "\n") {
			cursorStops.push({ index, column: rowColumns })
			rows.push({ start: rowStart, end: index, cursorStops })
			rowStart = index + 1
			rowColumns = 0
			cursorStops = []
			continue
		}

		const cellWidth = stringWidth(segment)
		if (rowColumns > 0 && rowColumns + cellWidth > width) {
			rows.push({ start: rowStart, end: index, cursorStops })
			rowStart = index
			rowColumns = 0
			cursorStops = []
		}
		cursorStops.push({ index, column: rowColumns })
		rowColumns += cellWidth
	}

	cursorStops.push({ index: text.length, column: rowColumns })
	rows.push({ start: rowStart, end: text.length, cursorStops })
	return rows
}

export function getInputCursorRow(rows: InputVisualRow[], cursorPosition: number): number {
	for (let index = 1; index < rows.length; index++) {
		if (rows[index].start > cursorPosition) return index - 1
	}
	return rows.length - 1
}
