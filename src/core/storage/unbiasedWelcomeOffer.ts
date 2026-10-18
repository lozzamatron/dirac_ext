import type { StateManager } from "@/core/storage/StateManager"
import { SecretKeys } from "@/shared/storage/state-keys"
import { getLatestAnnouncementId } from "@/utils/announcements"
import { listTaskDirectoryIds } from "./taskDirectory"

/** Classify once, before recordVersionUpgrade writes the first installed version. */
export async function initializeUnbiasedWelcomeOffer(stateManager: StateManager): Promise<void> {
	if (stateManager.getGlobalStateKey("unbiasedWelcomeOfferStatus") !== undefined) return

	// isNewUser alone is not a first-install marker: it stays true for the first ten tasks.
	const hasUsedDirac =
		stateManager.getGlobalStateKey("diracVersion") !== undefined ||
		stateManager.getGlobalStateKey("lastShownAnnouncementId") !== undefined ||
		stateManager.getGlobalStateKey("welcomeViewCompleted") === true ||
		stateManager.getGlobalStateKey("isNewUser") === false ||
		stateManager.getGlobalStateKey("taskHistory").length > 0 ||
		stateManager.getGlobalSettingsKey("modelProviderPresets").length > 0 ||
		SecretKeys.some((key) => key !== "authNonce" && Boolean(stateManager.getSecretKey(key))) ||
		// History repair happens later in startup; an empty index is not proof of no prior runs.
		(await listTaskDirectoryIds()).length > 0

	stateManager.setGlobalState("unbiasedWelcomeOfferStatus", hasUsedDirac ? "ineligible" : "pending")
	await stateManager.flushPendingState()
}

/** Dismissing the welcome offer also consumes the competing first-run announcement. */
export async function dismissUnbiasedWelcomeOffer(stateManager: StateManager): Promise<void> {
	if (stateManager.getGlobalStateKey("unbiasedWelcomeOfferStatus") !== "pending") return
	const previousState = {
		unbiasedWelcomeOfferStatus: stateManager.getGlobalStateKey("unbiasedWelcomeOfferStatus"),
		lastShownAnnouncementId: stateManager.getGlobalStateKey("lastShownAnnouncementId"),
		pendingReleaseNotesFromVersion: stateManager.getGlobalStateKey("pendingReleaseNotesFromVersion"),
	}
	stateManager.setGlobalStateBatch({
		unbiasedWelcomeOfferStatus: "dismissed",
		lastShownAnnouncementId: getLatestAnnouncementId(),
		pendingReleaseNotesFromVersion: undefined,
	})
	try {
		await stateManager.flushPendingState()
	} catch (error) {
		stateManager.setGlobalStateBatch(previousState)
		throw error
	}
}
