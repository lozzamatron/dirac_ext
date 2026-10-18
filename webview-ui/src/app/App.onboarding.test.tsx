import "@testing-library/jest-dom/vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useAppStore } from "./store/appStore"
import App from "./App"

const mocks = vi.hoisted(() => ({ acknowledge: vi.fn(), platformType: 0 }))
vi.mock("./Providers", () => ({ Providers: ({ children }: { children: ReactNode }) => children }))
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ type: mocks.platformType }) }))
vi.mock("@/features/onboarding/UnbiasedWelcomeModal", () => ({
	UnbiasedWelcomeModal: () => <div data-testid="welcome-offer">Welcome offer</div>,
}))
vi.mock("@/features/chat/components/ChatView/ChatView", () => ({
	default: ({ showAnnouncement }: { showAnnouncement: boolean }) => (
		<div data-testid="chat" data-announcement={showAnnouncement} />
	),
}))
vi.mock("@/features/settings/components/SettingsView/SettingsView", () => ({ default: () => null }))
vi.mock("@/features/history/components/HistoryView/HistoryView", () => ({ default: () => null }))
vi.mock("@/features/worktrees/components/WorktreesView", () => ({ default: () => null }))
vi.mock("@/features/banners/hooks/useBannerAction", () => ({ useBannerAction: () => vi.fn() }))
vi.mock("@/shared/ui/ReleaseNotesModal", () => ({ default: () => null }))
vi.mock("@/shared/api/grpc-client", () => ({
	UiServiceClient: { onDidShowAnnouncement: mocks.acknowledge },
	StateServiceClient: {},
}))

beforeEach(() => {
	vi.clearAllMocks()
	mocks.platformType = 0
	mocks.acknowledge.mockResolvedValue({ value: false })
	useAppStore.setState({
		didHydrateState: true,
		shouldShowUnbiasedWelcome: false,
		shouldShowAnnouncement: true,
		showSettings: false,
		showHistory: false,
		showWorktrees: false,
		showAnnouncement: false,
		releaseNotes: undefined,
		hydrate: () => () => {},
	})
})
afterEach(cleanup)

describe("First-run announcement precedence", () => {
	it("shows the welcome offer instead of the ordinary announcement for eligible VS Code users", () => {
		useAppStore.setState({ shouldShowUnbiasedWelcome: true })
		render(<App />)
		expect(screen.getByTestId("welcome-offer")).toBeInTheDocument()
		expect(screen.getByTestId("chat")).toHaveAttribute("data-announcement", "false")
		expect(mocks.acknowledge).not.toHaveBeenCalled()
	})

	it("waits for hydration before displaying either popup", () => {
		useAppStore.setState({ didHydrateState: false })
		render(<App />)
		expect(screen.queryByTestId("welcome-offer")).not.toBeInTheDocument()
		expect(mocks.acknowledge).not.toHaveBeenCalled()
		act(() => useAppStore.setState({ didHydrateState: true, shouldShowUnbiasedWelcome: true }))
		expect(screen.getByTestId("welcome-offer")).toBeInTheDocument()
		expect(mocks.acknowledge).not.toHaveBeenCalled()
	})

	it("preserves ordinary announcements for existing users", async () => {
		render(<App />)
		expect(screen.queryByTestId("welcome-offer")).not.toBeInTheDocument()
		await waitFor(() => expect(mocks.acknowledge).toHaveBeenCalledOnce())
		expect(screen.getByTestId("chat")).toHaveAttribute("data-announcement", "true")
	})

	it("does not follow dismissal with a competing announcement", () => {
		useAppStore.setState({ shouldShowUnbiasedWelcome: true })
		render(<App />)
		act(() => useAppStore.setState({ shouldShowUnbiasedWelcome: false, shouldShowAnnouncement: false }))
		expect(screen.queryByTestId("welcome-offer")).not.toBeInTheDocument()
		expect(mocks.acknowledge).not.toHaveBeenCalled()
	})

	it("does not show the VS Code welcome offer on standalone hosts", async () => {
		mocks.platformType = 1
		useAppStore.setState({ shouldShowUnbiasedWelcome: true })
		render(<App />)
		expect(screen.queryByTestId("welcome-offer")).not.toBeInTheDocument()
		await waitFor(() => expect(mocks.acknowledge).toHaveBeenCalledOnce())
	})
})
