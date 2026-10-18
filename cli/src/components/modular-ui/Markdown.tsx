import { Text } from "ink"
import React, { useMemo } from "react"
import { clipMarkdownLines, renderMarkdownLines } from "../../utils/markdown"

interface MarkdownProps {
	children: string
	color?: string
	width?: number
	maxLines?: number
	scrollOffset?: number
	padLines?: boolean
}

/** Keep parsing independent of the viewport; only formatted terminal rows are clipped. */
export const Markdown: React.FC<MarkdownProps> = ({ children, color, width, maxLines, scrollOffset = 0, padLines }) => {
	const columns = Math.max(1, width ?? process.stdout.columns ?? 80)
	const lines = useMemo(() => renderMarkdownLines(children, columns, color), [children, columns, color])
	const visibleText = maxLines ? clipMarkdownLines(lines, maxLines, scrollOffset).visibleText : lines.join("\n")
	const padding = padLines && maxLines ? "\n".repeat(Math.max(0, maxLines - Math.min(lines.length, maxLines))) : ""
	return (
		<Text>
			{visibleText}
			{padding}
		</Text>
	)
}
