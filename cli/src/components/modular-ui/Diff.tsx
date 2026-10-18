import { Box, Text } from "ink"
import React, { useMemo } from "react"
import type { DiffLine } from "../../utils/DiffComputer"
import { clipDiffRows, createDiffLayout, type DiffDisplayRow } from "../../utils/diff-layout"
import { styles, theme } from "../../constants/theme"
import { useTerminalSize } from "../../hooks/useTerminalSize"
import { linkifyPaths } from "../../utils/terminal-link"

interface DiffProps {
	/** Diff content (SEARCH/REPLACE format, ApplyPatch format, or raw content for new files) */
	content?: string
	/** File path (used for potential syntax highlighting in the future) */
	filePath?: string
	/** Number of context lines to show before/after changes (default: 2) */
	contextLines?: number
	/** Available render width from the parent body. */
	width?: number
	/** Diff layout. Auto uses split when there is enough width, unified otherwise. */
	variant?: "auto" | "unified" | "split"
	/** Clip formatted terminal rows, never patch source lines. */
	maxLines?: number
	scrollOffset?: number
}

const DIFF_COLORS = theme.diff
const SPLIT_SEPARATOR = " │ "

function lineNumberForSide(line: DiffLine | undefined, side: "old" | "new"): number | undefined {
	if (!line) return undefined
	return side === "old" ? line.oldLineNumber : line.newLineNumber
}

function lineTypeForSide(line: DiffLine | undefined, side: "old" | "new"): "add" | "remove" | "context" | undefined {
	if (!line) return undefined
	if (line.type === "context") return "context"
	if (side === "old" && line.type === "remove") return "remove"
	if (side === "new" && line.type === "add") return "add"
	return undefined
}

function prefixForType(type: "add" | "remove" | "context" | undefined): string {
	if (type === "add") return "+"
	if (type === "remove") return "-"
	return " "
}

function colorsForType(type: "add" | "remove" | "context" | undefined): {
	bgColor?: string
	fgColor?: string
} {
	if (type === "add") return { bgColor: DIFF_COLORS.addBg, fgColor: DIFF_COLORS.addFg }
	if (type === "remove") return { bgColor: DIFF_COLORS.removeBg, fgColor: DIFF_COLORS.removeFg }
	if (type === "context") return { fgColor: DIFF_COLORS.contextFg }
	return {}
}

function truncateLine(text: string, width: number): string {
	if (width <= 0) return ""
	if (text.length <= width) return text
	if (width === 1) return "…"
	return `${text.slice(0, width - 1)}…`
}

/** Render a single terminal row; wrapped continuations retain color but not a repeated line number. */
const UnifiedDiffLineRow: React.FC<{
	line: DiffLine
	gutterWidth: number
	continuation?: boolean
}> = ({ line, gutterWidth, continuation }) => {
	if (line.type === "separator") return <Text> </Text>
	const lineNum = continuation
		? undefined
		: line.type === "add"
			? line.newLineNumber
			: line.type === "remove"
				? line.oldLineNumber
				: line.newLineNumber
	const lineNumStr = lineNum !== undefined ? lineNum.toString().padStart(gutterWidth, " ") : " ".repeat(gutterWidth)
	const prefix = continuation ? " " : prefixForType(line.type)
	const { bgColor, fgColor } = colorsForType(line.type)

	return (
		<Box flexDirection="row" width="100%">
			<Box flexShrink={0} width={gutterWidth + 2}>
				<Text color={DIFF_COLORS.gutterFg}>
					{lineNumStr}
					{"  "}
				</Text>
			</Box>
			<Box backgroundColor={bgColor} flexGrow={1} paddingX={1}>
				<Text color={fgColor}>
					{prefix} {linkifyPaths(line.content || " ")}
				</Text>
			</Box>
		</Box>
	)
}

const BlockSeparator: React.FC<{ width: number }> = ({ width }) => (
	<Box marginY={0}>
		<Text color={theme.muted}>{"─".repeat(Math.min(40, Math.max(1, width - 4)))}</Text>
	</Box>
)

const CollapsedRow: React.FC<{ count: number; gutterWidth: number; width: number; split: boolean }> = ({
	count,
	gutterWidth,
	width,
	split,
}) => (
	<Text {...styles.tool.annotation}>
		{truncateLine(
			`${split ? "" : `${" ".repeat(gutterWidth)}   `}... ${count} unchanged line${count === 1 ? "" : "s"} ...`,
			width,
		)}
	</Text>
)

const SplitCell: React.FC<{
	line?: DiffLine
	side: "old" | "new"
	gutterWidth: number
	width: number
}> = ({ line, side, gutterWidth, width }) => {
	const type = lineTypeForSide(line, side)
	const lineNum = lineNumberForSide(line, side)
	const lineNumStr = lineNum !== undefined ? lineNum.toString().padStart(gutterWidth, " ") : " ".repeat(gutterWidth)
	const prefix = prefixForType(type)
	const { bgColor, fgColor } = colorsForType(type)
	const contentWidth = Math.max(1, width - gutterWidth - 3)
	const content = line ? truncateLine(line.content || " ", contentWidth) : ""

	return (
		<Box backgroundColor={bgColor} flexDirection="row" flexShrink={0} width={width}>
			<Box flexShrink={0} width={gutterWidth + 1}>
				<Text color={DIFF_COLORS.gutterFg}>{lineNumStr}</Text>
			</Box>
			<Box flexShrink={0} width={Math.max(1, width - gutterWidth - 1)}>
				<Text color={fgColor}>
					{prefix} {linkifyPaths(content)}
				</Text>
			</Box>
		</Box>
	)
}

const SplitDiffRow: React.FC<{
	row: Extract<DiffDisplayRow, { type: "split" }>
	gutterWidth: number
	width: number
}> = ({ row, gutterWidth, width }) => {
	const sideWidth = Math.max(10, Math.floor((width - SPLIT_SEPARATOR.length) / 2))
	return (
		<Box flexDirection="row" width="100%">
			<SplitCell gutterWidth={gutterWidth} line={row.oldLine} side="old" width={sideWidth} />
			<Text {...styles.tool.metadata}>{SPLIT_SEPARATOR}</Text>
			<SplitCell gutterWidth={gutterWidth} line={row.newLine} side="new" width={sideWidth} />
		</Box>
	)
}

/** Diff component for Modular UI. */
export const Diff: React.FC<DiffProps> = ({ content, contextLines = 2, width, variant = "auto", maxLines, scrollOffset = 0 }) => {
	const { columns: terminalWidth } = useTerminalSize()
	const renderWidth = Math.max(1, width ?? terminalWidth)
	const layout = useMemo(
		() => (content ? createDiffLayout(content, renderWidth, contextLines, variant) : null),
		[content, renderWidth, contextLines, variant],
	)
	if (!layout) return null
	const rows = maxLines === undefined ? layout.rows : clipDiffRows(layout.rows, maxLines, scrollOffset)
	return (
		<Box flexDirection="column" width={renderWidth}>
			{rows.map((row, index) => {
				switch (row.type) {
					case "separator":
						return <BlockSeparator key={index} width={renderWidth} />
					case "collapsed":
						return (
							<CollapsedRow
								key={index}
								count={row.count}
								gutterWidth={layout.gutterWidth}
								width={renderWidth}
								split={layout.split}
							/>
						)
					case "split":
						return <SplitDiffRow key={index} row={row} gutterWidth={layout.gutterWidth} width={renderWidth} />
					case "line":
						return (
							<UnifiedDiffLineRow
								key={index}
								line={row.line}
								continuation={row.continuation}
								gutterWidth={layout.gutterWidth}
							/>
						)
				}
			})}
		</Box>
	)
}
