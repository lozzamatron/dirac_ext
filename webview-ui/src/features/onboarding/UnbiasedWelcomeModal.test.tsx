import "@testing-library/jest-dom/vitest"
import { unbiasedDefaultModelId, type ApiConfiguration } from "@shared/api"
import { UnbiasedAuthEvent } from "@shared/proto/dirac/models"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Callbacks } from "@/shared/api/grpc-client-base"
import { UnbiasedWelcomeModal } from "./UnbiasedWelcomeModal"

const mocks = vi.hoisted(() => ({
	authenticate: vi.fn(),
	cancel: vi.fn(),
	dismiss: vi.fn(),
	openUrl: vi.fn(),
	save: vi.fn(),
	navigate: vi.fn(),
	settings: {
		apiConfiguration: {} as ApiConfiguration,
		apiConfigurationError: undefined as string | undefined,
		unbiasedWorkloadName: null as string | null,
		pendingApiConfigurationUpdates: {},
	},
}))
vi.mock("@/features/settings/store/settingsStore", () => ({
	useSettingsStore: Object.assign(
		(selector?: (state: typeof mocks.settings) => unknown) => (selector ? selector(mocks.settings) : mocks.settings),
		{ getState: () => mocks.settings },
	),
}))
vi.mock("@/app/store/appStore", () => ({ useAppStore: { getState: () => ({ navigateToChat: mocks.navigate }) } }))
vi.mock("@/features/settings/components/utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({ handleFieldsChange: mocks.save }),
}))
vi.mock("@/shared/api/grpc-client", () => ({
	ModelsServiceClient: { authenticateUnbiased: mocks.authenticate },
	StateServiceClient: { dismissUnbiasedWelcomeOffer: mocks.dismiss },
	UiServiceClient: { openUrl: mocks.openUrl },
	FileServiceClient: { copyToClipboard: vi.fn().mockResolvedValue({}) },
}))

function callbacks(index = 0): Callbacks<UnbiasedAuthEvent> {
	return mocks.authenticate.mock.calls[index][1]
}
function start() {
	const view = render(<UnbiasedWelcomeModal />)
	fireEvent.click(screen.getByRole("button", { name: "Get my free month" }))
	return view
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.settings.apiConfiguration = {}
	mocks.settings.apiConfigurationError = undefined
	mocks.authenticate.mockReturnValue(mocks.cancel)
	mocks.dismiss.mockResolvedValue({})
	mocks.openUrl.mockResolvedValue({})
	mocks.save.mockResolvedValue(true)
})
afterEach(cleanup)

describe("Unbiased welcome offer", () => {
	it("shows the celebration and exact offer without starting OAuth automatically", () => {
		render(<UnbiasedWelcomeModal />)
		expect(screen.getByRole("heading")).toHaveTextContent("🎉 Welcome to Dirac!")
		expect(screen.getByRole("dialog")).toHaveTextContent("1 month free on Unbiased’s Personal coding plan")
		expect(mocks.authenticate).not.toHaveBeenCalled()
	})

	it("starts existing OAuth from the CTA and opens the returned authorization URL", async () => {
		start()
		act(() =>
			callbacks().onResponse(
				UnbiasedAuthEvent.create({
					url: "https://platform.unbiased.ai/activate",
					userCode: "ABCD-EFGH",
					verificationUriComplete: "https://platform.unbiased.ai/activate?user_code=ABCD-EFGH",
				}),
			),
		)
		expect(mocks.authenticate).toHaveBeenCalledOnce()
		expect(mocks.openUrl).toHaveBeenCalledWith({ value: "https://platform.unbiased.ai/activate?user_code=ABCD-EFGH" })
		expect(screen.getByText("ABCD-EFGH")).toBeInTheDocument()
		expect(mocks.save).not.toHaveBeenCalled()
	})

	it("selects Unbiased in both modes only after OAuth succeeds", async () => {
		start()
		mocks.settings.apiConfiguration.unbiasedApiKey = "issued-key"
		await act(async () => callbacks().onResponse(UnbiasedAuthEvent.create({ completed: true })))
		expect(mocks.save).toHaveBeenCalledWith({
			planModeApiProvider: "unbiased",
			actModeApiProvider: "unbiased",
			planModeApiModelId: unbiasedDefaultModelId,
			actModeApiModelId: unbiasedDefaultModelId,
		})
		expect(mocks.dismiss).toHaveBeenCalledOnce()
		expect(mocks.navigate).toHaveBeenCalledOnce()
		expect(screen.queryByText(/free month activated/i)).not.toBeInTheDocument()
	})

	it("does not switch providers after cancellation, including a late completion", () => {
		start()
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
		act(() => callbacks().onResponse(UnbiasedAuthEvent.create({ completed: true })))
		expect(mocks.cancel).toHaveBeenCalledOnce()
		expect(mocks.save).not.toHaveBeenCalled()
		expect(mocks.dismiss).not.toHaveBeenCalled()
	})

	it("cancels polling when dismissed and ignores late OAuth completion", async () => {
		start()
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Not now" })))
		act(() => callbacks().onResponse(UnbiasedAuthEvent.create({ completed: true })))
		expect(mocks.cancel).toHaveBeenCalledOnce()
		expect(mocks.dismiss).toHaveBeenCalledOnce()
		expect(mocks.save).not.toHaveBeenCalled()
	})

	it("keeps browser instructions usable if automatic browser opening fails", async () => {
		mocks.openUrl.mockRejectedValue(new Error("browser unavailable"))
		start()
		await act(async () =>
			callbacks().onResponse(
				UnbiasedAuthEvent.create({
					url: "https://platform.unbiased.ai/activate",
					userCode: "ABCD",
					verificationUriComplete: "https://platform.unbiased.ai/activate?code=ABCD",
				}),
			),
		)
		expect(screen.getByRole("status")).toHaveTextContent("Could not open browser")
		expect(screen.getByText("ABCD")).toBeInTheDocument()
	})

	it("shows OAuth errors and allows retry without changing providers", () => {
		start()
		act(() => callbacks().onError(new Error("Sign-in code expired")))
		expect(screen.getByRole("alert")).toHaveTextContent("expired")
		fireEvent.click(screen.getByRole("button", { name: "Get my free month" }))
		expect(mocks.authenticate).toHaveBeenCalledTimes(2)
		expect(mocks.save).not.toHaveBeenCalled()
	})

	it("retains the saved login and offers setup retry when provider selection fails", async () => {
		mocks.save.mockResolvedValue(false)
		mocks.settings.apiConfigurationError = "Could not persist model selection"
		start()
		mocks.settings.apiConfiguration.unbiasedApiKey = "issued-key"
		await act(async () => callbacks().onResponse(UnbiasedAuthEvent.create({ completed: true })))
		expect(screen.getByRole("alert")).toHaveTextContent("Could not persist model selection")
		expect(mocks.dismiss).not.toHaveBeenCalled()
		mocks.save.mockResolvedValue(true)
		fireEvent.click(screen.getByRole("button", { name: "Start coding with Unbiased" }))
		await waitFor(() => expect(mocks.dismiss).toHaveBeenCalledOnce())
		expect(mocks.authenticate).toHaveBeenCalledOnce()
	})

	it("surfaces dismissal failures instead of silently losing the user's choice", async () => {
		mocks.dismiss.mockRejectedValue(new Error("disk full"))
		render(<UnbiasedWelcomeModal />)
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Not now" })))
		expect(screen.getByRole("alert")).toHaveTextContent("disk full")
		expect(screen.getByRole("button", { name: "Not now" })).toBeEnabled()
	})
})
