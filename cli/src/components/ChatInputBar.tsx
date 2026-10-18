import { theme } from "../constants/theme"
import React, { useMemo } from "react"
import { Box, Text } from "ink"
import { HighlightedInput } from "./HighlightedInput"
import { createInputViewport } from "../utils/input-viewport"
import { getInputContentWidth } from "../utils/input-layout"

interface ChatInputBarProps {
	borderColor: string
	inputPrompt?: string
	textInput: string
	cursorPos: number
	availableCommands: string[]
	show?: boolean
	terminalColumns?: number
	terminalRows?: number
}

export const ChatInputBar: React.FC<ChatInputBarProps> = ({
	borderColor,
	inputPrompt,
	textInput,
	cursorPos,
	availableCommands,
	show = true,
	terminalColumns,
	terminalRows,
}) => {
	const MAX_INPUT_LINES = 10

	const maxInputHeight = Math.max(1, Math.min(MAX_INPUT_LINES, Math.floor((terminalRows ?? 24) / 2) - 2))

	const contentWidth = getInputContentWidth(terminalColumns ?? 80, inputPrompt)

	/** Keep the cursor visible using the renderer's visual-row layout. */
	const viewport = useMemo(() => {
		return createInputViewport(textInput, cursorPos, contentWidth, maxInputHeight)
	}, [textInput, cursorPos, contentWidth, maxInputHeight])
	if (!show) return null

	return (
		<Box flexDirection="column" width="100%">
			<Box
				borderColor={borderColor}
				borderStyle="round"
				flexDirection="row"
				justifyContent="space-between"
				paddingLeft={1}
				paddingRight={1}
				maxHeight={maxInputHeight + 2}
				overflow="hidden"
				width="100%">
				<Box width="100%">
					<Box width={1} flexShrink={0}>
						<Text color={theme.muted} dimColor>
							{viewport.hasHiddenBefore ? "↑" : " "}
						</Text>
					</Box>
					{inputPrompt && (
						<Box flexShrink={0}>
							<Text color={borderColor} bold>
								{inputPrompt}{" "}
							</Text>
						</Box>
					)}
					<HighlightedInput
						availableCommands={availableCommands}
						columns={contentWidth}
						cursorPos={viewport.cursorPosition}
						text={viewport.text}
					/>
					<Box width={1} flexShrink={0} justifyContent="flex-end" flexDirection="column">
						<Text color={theme.muted} dimColor>
							{viewport.hasHiddenAfter ? "↓" : " "}
						</Text>
					</Box>
				</Box>
			</Box>
		</Box>
	)
}
