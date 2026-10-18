import { type DiracMessage, DiracMessageType } from "@shared/ExtensionMessage"
import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import ActionButtons from "./ActionButtons"

// Dirac EXT: the state that used to wipe the composer — the agent is thinking (api_status) right after a
// shell command (terminal card). Upstream cleared the input from an effect keyed on a `chatState` object
// that is rebuilt on every render, so each keystroke's render cleared the keystroke.
const terminalCard = {
	id: "cmd-1",
	ts: 1,
	content: { type: DiracMessageType.CARD, card: { icon: "terminal", status: "completed" } },
} as unknown as DiracMessage
const thinking = {
	id: "api-2",
	ts: 2,
	content: { type: DiracMessageType.API_STATUS },
} as unknown as DiracMessage

function chatStateFor(inputValue: string, setters: Record<string, ReturnType<typeof vi.fn>>) {
	// A fresh object per render, exactly as useChatState returns it.
	return {
		inputValue,
		selectedImages: [],
		selectedFiles: [],
		uiActionState: { globalButtons: [], cardButtons: [], sendingDisabled: false },
		lastMessage: thinking,
		secondLastMessage: terminalCard,
		activeVoiceStreamId: undefined,
		isApiRequestActive: true,
		...setters,
	} as any
}

describe("Dirac EXT ActionButtons composer", () => {
	it("does not clear what the user is typing while the agent thinks after a shell command", () => {
		const setters = {
			setInputValue: vi.fn(),
			setSelectedImages: vi.fn(),
			setSelectedFiles: vi.fn(),
			setSendingDisabled: vi.fn(),
		}
		const props = {
			messageHandlers: { executeButtonAction: vi.fn() } as any,
			scrollBehavior: { scrollToBottomSmooth: vi.fn(), scrollToTop: vi.fn(), showScrollToBottom: false },
		}

		const { rerender } = render(<ActionButtons chatState={chatStateFor("", setters)} {...props} />)
		// one render per keystroke
		for (const draft of ["h", "he", "hel", "hell", "hello"]) {
			rerender(<ActionButtons chatState={chatStateFor(draft, setters)} {...props} />)
		}

		expect(setters.setInputValue).not.toHaveBeenCalled()
		expect(setters.setSelectedImages).not.toHaveBeenCalled()
		expect(setters.setSelectedFiles).not.toHaveBeenCalled()
	})
})
