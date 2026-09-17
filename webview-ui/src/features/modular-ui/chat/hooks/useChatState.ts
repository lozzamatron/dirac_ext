import { EmptyRequest } from "@shared/proto/dirac/common"
import { useCallback, useEffect, useRef, useState } from "react"
import { ChatState } from "../types/chatTypes"
import { useChatStore } from "@/features/chat/store/chatStore"
import { UiServiceClient } from "@/shared/api/grpc-client"
import { useShallow } from "zustand/react/shallow"

/**
 * Custom hook for managing chat state
 * Handles input values, selection states, and UI state
 */
export function useChatState(): ChatState {
	// Input and selection state
	const [inputValue, setInputValue] = useState("")
	const [activeQuote, setActiveQuote] = useState<string | null>(null)
	const [isTextAreaFocused, setIsTextAreaFocused] = useState(false)
	const [selectedImages, setSelectedImages] = useState<string[]>([])
	const [selectedFiles, setSelectedFiles] = useState<string[]>([])

	// UI state
	const [sendingDisabled, setSendingDisabled] = useState(false)
	const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({})

	// Refs
	const textAreaRef = useRef<HTMLTextAreaElement>(null)

	// Derived state
	const presentationState = useChatStore(
		useShallow((state) => ({
			lastMessage: state.lastMessage,
			secondLastMessage: state.secondLastMessage,
			task: state.taskMessage,
			uiActionState: state.uiActionState,
			activeVoiceStreamId: state.activeVoiceStreamId,
			isApiRequestActive: state.isApiRequestActive,
			taskStatus: state.taskStatus,
		})),
	)
	const { lastMessage, secondLastMessage, task } = presentationState

	// Clear expanded rows when task changes
	const clearExpandedRows = useCallback(() => {
		setExpandedRows({})
		useChatStore.getState().clearCardCollapsedStates()
	}, [])

	// Reset state when starting new conversation
	const resetState = useCallback(() => {
		setInputValue("")
		setActiveQuote(null)
		setSelectedImages([])
		setSelectedFiles([])
	}, [])

	// Handle focus change
	const handleFocusChange = useCallback((isFocused: boolean) => {
		setIsTextAreaFocused(isFocused)
	}, [])

	// Auto-expand last message row when task or messages first changed.
	useEffect(() => {
		clearExpandedRows()
	}, [task?.id, clearExpandedRows])

	// Dirac EXT: receive "Add to Dirac" / "Add terminal output to chat" text from the host.
	//
	// The extension has always sent this over the addToInput stream, but upstream's webview never
	// subscribed to it, so the selection went nowhere. Append it to whatever is already typed and
	// put the caret at the end, the way the editor-context commands imply.
	useEffect(() => {
		const cleanup = UiServiceClient.subscribeToAddToInput({} as EmptyRequest, {
			onResponse: (event) => {
				const text = event?.value
				if (!text) {
					return
				}
				setInputValue((current) => (current.trim() ? `${current}\n${text}` : text))
				const textArea = textAreaRef.current
				if (textArea) {
					// Defer: the value lands on the next render.
					setTimeout(() => {
						textArea.focus()
						const end = textArea.value.length
						textArea.setSelectionRange(end, end)
					}, 0)
				}
			},
			onError: (error) => console.error("Error in addToInput subscription:", error),
			onComplete: () => {},
		})
		return cleanup
	}, [])

	return {
		// State values
		inputValue,
		setInputValue,
		activeQuote,
		setActiveQuote,
		isTextAreaFocused,
		setIsTextAreaFocused,
		selectedImages,
		setSelectedImages,
		selectedFiles,
		setSelectedFiles,
		sendingDisabled,
		setSendingDisabled,
		expandedRows,
		setExpandedRows,

		// Refs
		textAreaRef,

		// Derived values
		...presentationState,

		// Handlers
		handleFocusChange,
		clearExpandedRows,
		resetState,
	}
}
