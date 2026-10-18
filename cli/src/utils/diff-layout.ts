import wrapAnsi from "wrap-ansi"
import { computeDiff, type DiffBlock, type DiffLine, getGutterWidth } from "./DiffComputer"

export type DiffDisplayRow =
	| { type: "line"; line: DiffLine; continuation?: boolean }
	| { type: "split"; oldLine?: DiffLine; newLine?: DiffLine }
	| { type: "collapsed"; count: number }
	| { type: "separator" }

export interface DiffLayout {
	rows: DiffDisplayRow[]
	gutterWidth: number
	split: boolean
}

const DEFAULT_CONTEXT_LINES = 2
const MIN_SPLIT_WIDTH = 80

/** Parse the complete patch before collapsing context, pairing changes or wrapping rows. */
export function createDiffLayout(
	content: string,
	width: number,
	contextLines = DEFAULT_CONTEXT_LINES,
	variant: "auto" | "unified" | "split" = "auto",
): DiffLayout {
	const diff = computeDiff(content)
	const gutterWidth = getGutterWidth(diff)
	const split = variant === "split" || (variant === "auto" && width >= MIN_SPLIT_WIDTH)
	const contentWidth = Math.max(1, width - gutterWidth - 6)
	const rows = diff.blocks.flatMap((block, index): DiffDisplayRow[] => {
		const collapsed = collapseContext(block, contextLines)
		const blockRows = split
			? toSplitRows(collapsed)
			: collapsed.flatMap((row): DiffDisplayRow[] => {
					if (row.type !== "line") return [row]
					return wrapAnsi(row.line.content || " ", contentWidth, { hard: true, trim: false })
						.split("\n")
						.map((content, part) => ({
							type: "line",
							line: { ...row.line, content },
							continuation: part > 0,
						}))
				})
		return index > 0 ? [{ type: "separator" }, ...blockRows] : blockRows
	})
	return { rows, gutterWidth, split }
}

/** Select terminal rows using the same bottom-relative offset as other card renderers. */
export function clipDiffRows(rows: DiffDisplayRow[], maxLines: number, scrollOffset: number): DiffDisplayRow[] {
	const budget = Math.max(1, maxLines)
	const maxScroll = Math.max(0, rows.length - budget)
	const start = maxScroll - Math.min(maxScroll, Math.max(0, scrollOffset))
	return rows.slice(start, start + budget)
}

function collapseContext(block: DiffBlock, contextLines: number): DiffDisplayRow[] {
	const lines = block.lines
	const changeIndices = lines.flatMap((line, index) => (line.type === "add" || line.type === "remove" ? [index] : []))
	if (changeIndices.length === 0) return lines.map((line) => ({ type: "line", line }))

	const keepIndices = new Set<number>()
	for (const changeIdx of changeIndices) {
		for (let i = Math.max(0, changeIdx - contextLines); i <= Math.min(lines.length - 1, changeIdx + contextLines); i++) {
			keepIndices.add(i)
		}
	}

	const rows: DiffDisplayRow[] = []
	let hiddenCount = 0
	for (let i = 0; i < lines.length; i++) {
		if (!keepIndices.has(i)) {
			hiddenCount++
			continue
		}
		if (hiddenCount > 0) rows.push({ type: "collapsed", count: hiddenCount })
		hiddenCount = 0
		rows.push({ type: "line", line: lines[i] })
	}
	if (hiddenCount > 0) rows.push({ type: "collapsed", count: hiddenCount })
	return rows
}

function toSplitRows(displayLines: DiffDisplayRow[]): DiffDisplayRow[] {
	const rows: DiffDisplayRow[] = []
	let index = 0
	while (index < displayLines.length) {
		const item = displayLines[index]
		if (item.type !== "line") {
			rows.push(item)
			index++
			continue
		}
		if (item.line.type === "separator") {
			rows.push({ type: "separator" })
			index++
			continue
		}
		if (item.line.type === "context") {
			rows.push({ type: "split", oldLine: item.line, newLine: item.line })
			index++
			continue
		}

		const removes: DiffLine[] = []
		const adds: DiffLine[] = []
		while (index < displayLines.length) {
			const change = displayLines[index]
			if (change.type !== "line" || (change.line.type !== "remove" && change.line.type !== "add")) break
			if (change.line.type === "remove") removes.push(change.line)
			if (change.line.type === "add") adds.push(change.line)
			index++
		}
		for (let i = 0; i < Math.max(removes.length, adds.length); i++) {
			rows.push({ type: "split", oldLine: removes[i], newLine: adds[i] })
		}
	}
	return rows
}
