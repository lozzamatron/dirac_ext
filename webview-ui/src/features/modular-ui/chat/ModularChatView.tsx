import { DiracMessageType, Mode } from "@shared/ExtensionMessage"
import React, { useCallback, useEffect, useMemo, useState } from "react"
import { useMount } from "react-use"
import { useAppStore } from "@/app/store/appStore"
import { useShowNavbar } from "@/context/PlatformContext"
import { useTaskStore } from "@/entities/task/store/taskStore"
import { useChatStore } from "@/features/chat/store/chatStore"
import { normalizeApiConfiguration } from "@/features/settings/components/utils/providerUtils"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { cn } from "@/lib/utils"
import { Navbar } from "@/shared/ui/Navbar"
import { AgentMapOverlay } from "@/features/agent-map/AgentMapOverlay"
import { buildAgentMap } from "@/features/agent-map/buildAgentMap"
import type { AgentMapSnapshot } from "@shared/agentMap"
import { ChatLayout } from "./components/ChatLayout"
import { SurfaceStrip } from "./components/SurfaceStrip"
import { InteractionState, useInteractionState } from "./context/InteractionStateContext"
// Decorators
import { ActionButtonsDecorator } from "./decorators/view/ActionButtonsDecorator"
import { AutoApproveDecorator } from "./decorators/view/AutoApproveDecorator"
import { useChatState } from "./hooks/useChatState"
import { useMessageHandlers } from "./hooks/useMessageHandlers"
import { useScrollBehavior } from "./hooks/useScrollBehavior"
import { GoalSection } from "./sections/GoalSection"
// Sections
import { InputSection } from "./sections/InputSection"
import { MessagesSection } from "./sections/MessagesSection"
import { TaskSection } from "./sections/TaskSection"
import { WelcomeSection } from "./sections/WelcomeSection"
import { ChatSection, ChatViewContext, ChatViewDecorator, ChatViewProps } from "./types"
import { useShallow } from "zustand/react/shallow"

// Stand-in while the map is closed, so the snapshot memo can skip the walk over every message.
const EMPTY_AGENT_MAP: AgentMapSnapshot = { rootTaskId: "", generatedAt: 0, nodes: [] }

export const ModularChatView: React.FC<ChatViewProps> = ({ isHidden, showAnnouncement, hideAnnouncement, showHistoryView }) => {
	const showNavbar = useShowNavbar()
	const version = useAppStore((state) => state.version)
	const { messages, task, renderedMessageIds, apiMetrics, lastApiReqInfo } = useChatStore(
		useShallow((state) => ({
			messages: state.diracMessages,
			task: state.taskMessage,
			renderedMessageIds: state.visibleMessageIds,
			apiMetrics: state.apiMetrics,
			lastApiReqInfo: state.lastApiReqInfo,
		})),
	)
	const goal = useChatStore((state) => state.goal)
	const taskHistory = useTaskStore((state) => state.taskHistory)
	const apiConfiguration = useSettingsStore((state) => state.apiConfiguration)
	const telemetrySetting = useSettingsStore((state) => state.telemetrySetting)
	const mode = useSettingsStore((state) => state.mode)
	const effectiveMode = goal?.mode ?? mode
	const shouldShowQuickWins = !!taskHistory && taskHistory.length > 0

	const chatState = useChatState()
	const { sendingDisabled, uiActionState, expandedRows, setExpandedRows, textAreaRef } = chatState

	const messageHandlers = useMessageHandlers(chatState)

	const { state: interactionState } = useInteractionState()
	const { selectedModelInfo, selectedModelId, selectedProvider } = useMemo(() => {
		return normalizeApiConfiguration(apiConfiguration, effectiveMode as Mode)
	}, [apiConfiguration, effectiveMode])

	// --- Agent Map (WP4) ---------------------------------------------------------------------
	// Built here rather than inside the overlay because every input already lives in this component,
	// and a pure builder is what makes it unit-testable against captured real runs.
	const presentationSurfaceId = useChatStore((state) => state.presentationSurfaceId)
	const [agentMapOpen, setAgentMapOpen] = useState(false)
	const openAgentMap = useCallback(() => setAgentMapOpen(true), [])
	const closeAgentMap = useCallback(() => setAgentMapOpen(false), [])

	const agentMapSnapshot = useMemo(() => {
		// Only built while the map is open. buildAgentMap walks every message and reads every card, and
		// this memo's inputs change on every streamed chunk — doing that work for a user who never
		// opens the map would put an O(messages) pass in the way of the transcript rendering.
		if (!agentMapOpen) {
			return EMPTY_AGENT_MAP
		}
		const taskContent = task?.content
		const taskText = taskContent?.type === DiracMessageType.MARKDOWN ? taskContent.content : undefined
		// The context figure is the one the task header already shows: everything the next request
		// will carry, cached tokens included. Deriving it a second way here would put two different
		// numbers for the same thing on screen.
		const contextTokens = lastApiReqInfo
			? (lastApiReqInfo.tokensIn ?? 0) +
				(lastApiReqInfo.tokensOut ?? 0) +
				(lastApiReqInfo.cacheWrites ?? 0) +
				(lastApiReqInfo.cacheReads ?? 0)
			: undefined
		return buildAgentMap({
			rootTaskId: presentationSurfaceId ?? "",
			taskText,
			messages,
			goal: goal ?? undefined,
			modelId: selectedModelId,
			contextTokens: contextTokens && contextTokens > 0 ? contextTokens : undefined,
		})
	}, [agentMapOpen, task, messages, goal, selectedModelId, lastApiReqInfo, presentationSurfaceId])

	// Ctrl/Cmd+Shift+M toggles the map while this webview has focus. It is handled here rather than
	// as a VS Code keybinding because WP4 adds no extension-host code, and a webview binding works
	// the same in the sidebar and in a tab.
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			// isComposing: during IME composition a keystroke belongs to the text being composed, not to
			// a command. The shortcut deliberately works while the chat input has focus — the input is
			// focused almost all the time, so a guard on that would make the shortcut unreachable.
			if (
				!event.isComposing &&
				(event.ctrlKey || event.metaKey) &&
				event.shiftKey &&
				(event.key === "m" || event.key === "M")
			) {
				event.preventDefault()
				setAgentMapOpen((open) => !open)
			}
		}
		window.addEventListener("keydown", onKeyDown)
		return () => window.removeEventListener("keydown", onKeyDown)
	}, [])

	useMount(() => {
		textAreaRef.current?.focus()
	})

	const hasButtons = (uiActionState?.globalButtons.length ?? 0) > 0 || (uiActionState?.cardButtons.length ?? 0) > 0
	useEffect(() => {
		const timer = setTimeout(() => {
			if (!isHidden && !sendingDisabled && !hasButtons && document.hasFocus()) {
				textAreaRef.current?.focus()
			}
		}, 50)
		return () => {
			clearTimeout(timer)
		}
	}, [isHidden, sendingDisabled, hasButtons, textAreaRef])

	const scrollBehavior = useScrollBehavior(messages, renderedMessageIds, renderedMessageIds, expandedRows, setExpandedRows)

	const placeholderText = useMemo(() => {
		if (goal?.followUpActive) return "Steer this follow-up…"
		if (goal?.status === "working") return "Steer this Goal…"
		if (goal?.status === "waiting") return "Steer this Goal while requests await a response…"
		if (goal?.status === "paused") return "Ask a follow-up (Goal stays paused)…"
		if (goal?.status === "blocked") return "Ask a follow-up (Goal stays blocked)…"
		if (goal?.status === "achieved" || goal?.status === "stopped") return "Ask a follow-up…"
		if (!task) return "Type your task here..."
		if (interactionState === InteractionState.RUNNING) return "Send guidance for the next turn without interrupting…"
		return "Type a message..."
	}, [goal, task, interactionState])

	const context = useMemo<ChatViewContext>(
		() => ({
			goal,
			task,
			renderedMessageIds,
			apiMetrics,
			lastApiReqInfo,
			chatState,
			messageHandlers,
			scrollBehavior,
			isHidden,
			showAnnouncement,
			hideAnnouncement,
			showHistoryView,
			version,
			taskHistory,
			shouldShowQuickWins,
			telemetrySetting,
			selectedModelInfo: {
				...selectedModelInfo,
				selectedModelId,
				selectedProvider,
				mode: effectiveMode,
			},
			placeholderText,
		}),
		[
			goal,
			task,
			renderedMessageIds,
			apiMetrics,
			lastApiReqInfo,
			chatState,
			messageHandlers,
			scrollBehavior,
			isHidden,
			showAnnouncement,
			hideAnnouncement,
			showHistoryView,
			version,
			taskHistory,
			shouldShowQuickWins,
			telemetrySetting,
			selectedModelInfo,
			selectedModelId,
			selectedProvider,
			effectiveMode,
			placeholderText,
		],
	)

	const sections = useMemo<ChatSection[]>(() => [WelcomeSection, GoalSection, TaskSection, MessagesSection, InputSection], [])

	const decorators = useMemo<ChatViewDecorator[]>(() => [AutoApproveDecorator, ActionButtonsDecorator], [])

	return (
		<ChatLayout isHidden={isHidden}>
			<div className="modular-chat-shell flex flex-col flex-1 overflow-hidden relative">
				<div
					className={cn(
						"modular-chat-shell flex flex-col flex-1 overflow-hidden",
						effectiveMode === "plan" ? "bg-grid-plan" : "",
					)}>
					<SurfaceStrip onOpenAgentMap={openAgentMap} />
					{showNavbar && <Navbar />}
					<div className="flex-1 flex flex-col overflow-hidden relative">
						{sections.map((section) => (
							<React.Fragment key={section.id}>
								{section.id !== "input" && section.shouldRender(context) && section.render(context)}
							</React.Fragment>
						))}
					</div>

					<div className="flex flex-col gap-2">
						{decorators.map((decorator) => (
							<React.Fragment key={decorator.id}>{decorator.render?.(context)}</React.Fragment>
						))}
					</div>

					<div className="px-4">{InputSection.shouldRender(context) && InputSection.render(context)}</div>
				</div>
			</div>
			{agentMapOpen && <AgentMapOverlay onClose={closeAgentMap} snapshot={agentMapSnapshot} />}
		</ChatLayout>
	)
}
