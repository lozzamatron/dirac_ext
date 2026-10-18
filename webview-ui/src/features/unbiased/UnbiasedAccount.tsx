import { EmptyRequest, StringRequest } from "@shared/proto/dirac/common"
import type { UnbiasedAuthEvent } from "@shared/proto/dirac/models"
import { useEffect, useRef, useState } from "react"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { FileServiceClient, ModelsServiceClient, UiServiceClient } from "@/shared/api/grpc-client"
import { Button } from "@/shared/ui/button"

interface UnbiasedAccountProps {
	signInLabel?: string
	autoOpenBrowser?: boolean
	disabled?: boolean
	onSignedIn?: () => void
}

/** Shared device-auth UI for provider settings and first-run onboarding. */
export function UnbiasedAccount({
	signInLabel = "Sign in with Unbiased",
	autoOpenBrowser = false,
	disabled = false,
	onSignedIn,
}: UnbiasedAccountProps) {
	const { apiConfiguration, unbiasedWorkloadName, pendingApiConfigurationUpdates } = useSettingsStore()
	const isAuthenticated = !!apiConfiguration?.unbiasedApiKey
	const workloadName = Object.hasOwn(pendingApiConfigurationUpdates, "unbiasedApiKey") ? undefined : unbiasedWorkloadName
	const [instructions, setInstructions] = useState<UnbiasedAuthEvent>()
	const [isSigningIn, setIsSigningIn] = useState(false)
	const [isSigningOut, setIsSigningOut] = useState(false)
	const [error, setError] = useState<string>()
	const [notice, setNotice] = useState<string>()
	const cancelRef = useRef<() => void>()
	const attempt = useRef(0)
	const cancel = () => {
		attempt.current++
		cancelRef.current?.()
		cancelRef.current = undefined
		setIsSigningIn(false)
		setInstructions(undefined)
	}
	useEffect(
		() => () => {
			attempt.current++
			cancelRef.current?.()
		},
		[],
	)

	const openBrowser = (url: string, generation: number) => {
		void UiServiceClient.openUrl(StringRequest.create({ value: url })).catch(() => {
			if (generation === attempt.current) setNotice("Could not open browser; use the URL above.")
		})
	}

	const signIn = () => {
		cancel()
		setError(undefined)
		setNotice(undefined)
		setIsSigningIn(true)
		const generation = attempt.current
		cancelRef.current = ModelsServiceClient.authenticateUnbiased(EmptyRequest.create({}), {
			onResponse: (event) => {
				if (generation !== attempt.current) return
				if (event.completed) {
					setNotice(`Signed in to ${event.workloadName || "Unbiased"}.`)
					setIsSigningIn(false)
					setInstructions(undefined)
					onSignedIn?.()
					return
				}
				setInstructions(event)
				if (autoOpenBrowser) openBrowser(event.verificationUriComplete, generation)
			},
			onError: (failure) => {
				if (generation !== attempt.current) return
				setError(failure.message)
				cancel()
			},
			onComplete: () => {
				if (generation !== attempt.current) return
				cancelRef.current = undefined
				setIsSigningIn(false)
				setInstructions(undefined)
			},
		})
	}

	const signOut = async () => {
		setIsSigningOut(true)
		setError(undefined)
		setNotice(undefined)
		try {
			await ModelsServiceClient.signOutUnbiased(EmptyRequest.create({}))
			setNotice("Signed out locally. Revoke the key in the Unbiased dashboard to disable it.")
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Unbiased sign-out failed")
		} finally {
			setIsSigningOut(false)
		}
	}

	const copy = async (value: string) => {
		try {
			await FileServiceClient.copyToClipboard(StringRequest.create({ value }))
			setNotice("Copied to clipboard.")
		} catch {
			setNotice("Could not copy. Select the text above instead.")
		}
	}

	return (
		<div className="space-y-2">
			{isAuthenticated ? (
				<section aria-label="Unbiased account" className="rounded-md border border-(--vscode-panel-border) p-3">
					<div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
						<div className="min-w-0">
							<p className="m-0 text-sm font-medium">Connected to Unbiased</p>
							<p className="mb-0 mt-1 break-all text-xs">Signed in to {workloadName || "Unbiased"}</p>
						</div>
						<Button
							disabled={disabled || isSigningIn || isSigningOut}
							onClick={() => void signOut()}
							size="sm"
							type="button"
							variant="outline">
							{isSigningOut ? "Signing out…" : "Sign out on this device"}
						</Button>
					</div>
				</section>
			) : (
				<Button disabled={disabled || isSigningIn || isSigningOut} onClick={signIn} size="sm" type="button">
					{signInLabel}
				</Button>
			)}
			{isSigningIn && <p className="text-xs">{instructions ? "Waiting for approval…" : "Preparing sign-in…"}</p>}
			{instructions && (
				<div className="space-y-2 text-xs">
					<p>Open this page and enter the code (works on remote machines):</p>
					<input aria-label="Unbiased verification URL" className="w-full" readOnly value={instructions.url} />
					<code className="select-all text-base">{instructions.userCode}</code>
					<div className="flex flex-wrap gap-2">
						<Button onClick={() => void copy(instructions.userCode)} size="sm" type="button" variant="outline">
							Copy code
						</Button>
						<Button onClick={() => void copy(instructions.url)} size="sm" type="button" variant="outline">
							Copy URL
						</Button>
						<Button
							onClick={() => openBrowser(instructions.verificationUriComplete, attempt.current)}
							size="sm"
							type="button">
							Open browser
						</Button>
					</div>
				</div>
			)}
			{isSigningIn && (
				<Button disabled={disabled} onClick={cancel} size="sm" type="button" variant="ghost">
					Cancel
				</Button>
			)}
			{notice && (
				<p className="text-xs" role="status">
					{notice}
				</p>
			)}
			{error && (
				<p className="text-xs" role="alert">
					{error}
				</p>
			)}
		</div>
	)
}
