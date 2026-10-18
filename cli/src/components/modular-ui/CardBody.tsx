import { styles } from "../../constants/theme"
import { RenderType } from "@shared/ExtensionMessage"
import { cardBodyForDisplay } from "../../utils/card-body"
import React, { useMemo } from "react"
import { Text, Box } from "ink"
import { Diff } from "./Diff"
import { linkifyPaths } from "../../utils/terminal-link"
import { clipTextToWindow } from "../../utils/text-clipping"
import { clipMarkdownLines, renderMarkdownLines } from "../../utils/markdown"
import { Markdown } from "./Markdown"

interface CardBodyProps {
	body?: string
	maxLines?: number
	renderType: RenderType
	scrollOffset?: number
	renderWidth?: number
}

export const CardBody: React.FC<CardBodyProps> = ({ body, maxLines, renderType, scrollOffset, renderWidth }) => {
	const displayBody = cardBodyForDisplay(body, renderType)
	const columns = Math.max(1, renderWidth ?? (process.stdout.columns || 80) - 6)
	const markdownLines = useMemo(
		() => renderType === "markdown" && maxLines ? renderMarkdownLines(displayBody, columns, styles.tool.body.color) : undefined,
		[displayBody, columns, renderType, maxLines],
	)
	const { visibleText, hasMoreAbove, hasMoreBelow } = maxLines
		? markdownLines
			? clipMarkdownLines(markdownLines, maxLines, scrollOffset ?? 0)
			: clipTextToWindow(displayBody, maxLines, columns, scrollOffset ?? 0)
		: { visibleText: displayBody, hasMoreAbove: false, hasMoreBelow: false }
	if (!displayBody) return null
	return (
		<Box flexDirection="column">
			{maxLines ? <Text {...styles.tool.body}>{visibleText}</Text> : renderContent(visibleText, renderType, columns)}
			{(hasMoreAbove || hasMoreBelow) && (
				<Box marginTop={0}>
					<Text {...styles.tool.metadata}>
						{hasMoreAbove ? "↑ " : ""}scroll{hasMoreBelow ? " ↓" : ""}
					</Text>
				</Box>
			)}
		</Box>
	)
}

function renderContent(body: string, renderType: RenderType, width: number): React.ReactNode {
	switch (renderType) {
		case "markdown":
			return <Markdown color={styles.tool.body.color} width={width}>{body}</Markdown>
		case "diff":
			return <Diff content={body} width={width} />
		case "text":
		default:
			return <Text {...styles.tool.body}>{linkifyPaths(body)}</Text>
	}
}
