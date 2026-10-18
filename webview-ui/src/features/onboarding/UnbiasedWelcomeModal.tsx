import { unbiasedDefaultModelId } from "@shared/api"
import { useRef, useState } from "react"
import { useAppStore } from "@/app/store/appStore"
import { useApiConfigurationHandlers } from "@/features/settings/components/utils/useApiConfigurationHandlers"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { UnbiasedAccount } from "@/features/unbiased/UnbiasedAccount"
import { StateServiceClient, UiServiceClient } from "@/shared/api/grpc-client"
import { Button } from "@/shared/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/shared/ui/dialog"

export function UnbiasedWelcomeModal() {
	const { handleFieldsChange } = useApiConfigurationHandlers()
	const isAuthenticated = useSettingsStore((state) => !!state.apiConfiguration?.unbiasedApiKey)
	const [isSaving, setIsSaving] = useState(false)
	const [isDismissing, setIsDismissing] = useState(false)
	const [error, setError] = useState<string>()
	const busy = useRef(false)

	const dismiss = async () => {
		if (busy.current) return
		busy.current = true
		setIsDismissing(true)
		setError(undefined)
		try {
			await StateServiceClient.dismissUnbiasedWelcomeOffer({})
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not save your choice. Please try again.")
		} finally {
			busy.current = false
			setIsDismissing(false)
		}
	}

	const finishSetup = async () => {
		if (busy.current) return
		busy.current = true
		setIsSaving(true)
		setError(undefined)
		try {
			const saved = await handleFieldsChange({
				planModeApiProvider: "unbiased",
				actModeApiProvider: "unbiased",
				planModeApiModelId: unbiasedDefaultModelId,
				actModeApiModelId: unbiasedDefaultModelId,
			})
			if (!saved) {
				throw new Error(
					useSettingsStore.getState().apiConfigurationError || "Could not select Unbiased. Please try again.",
				)
			}
			await StateServiceClient.dismissUnbiasedWelcomeOffer({})
			useAppStore.getState().navigateToChat()
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not finish setup. Please try again.")
		} finally {
			busy.current = false
			setIsSaving(false)
		}
	}

	return (
		<Dialog
			onOpenChange={(open) => {
				if (!open) void dismiss()
			}}
			open>
			<DialogContent className="max-h-[85vh] overflow-y-auto p-5" hideClose={isSaving || isDismissing}>
				<DialogTitle className="pr-6 leading-snug">🎉 Welcome to Dirac!</DialogTitle>
				<DialogDescription className="m-0 leading-relaxed">
					Dirac users get <strong className="text-foreground">1 month free</strong> on Unbiased’s Personal coding plan.{" "}
					Connect your Unbiased account to get started.
				</DialogDescription>
				{!isDismissing && (
					<UnbiasedAccount
						autoOpenBrowser
						disabled={isSaving}
						onSignedIn={() => void finishSetup()}
						signInLabel="Get my free month"
					/>
				)}
				{isAuthenticated && (
					<Button disabled={isSaving || isDismissing} onClick={() => void finishSetup()} type="button">
						{isSaving ? "Finishing setup…" : "Start coding with Unbiased"}
					</Button>
				)}
				{error && (
					<p className="m-0 text-sm text-error" role="alert">
						{error}
					</p>
				)}
				<div className="flex flex-wrap items-center justify-between gap-2">
					<Button disabled={isSaving || isDismissing} onClick={() => void dismiss()} type="button" variant="ghost">
						{isDismissing ? "Saving…" : "Not now"}
					</Button>
					<button
						className="cursor-pointer text-xs text-(--vscode-textLink-foreground) hover:underline"
						onClick={() =>
							void UiServiceClient.openUrl({ value: "https://unbiased.ai/" }).catch((failure: Error) =>
								setError(failure.message),
							)
						}
						type="button">
						Learn more at unbiased.ai
					</button>
				</div>
			</DialogContent>
		</Dialog>
	)
}
