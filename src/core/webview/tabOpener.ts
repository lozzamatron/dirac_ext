/**
 * Seam for opening a new Dirac EXT editor tab from the webview.
 *
 * Core must not import `vscode`, so the host registers the actual tab-opening
 * implementation at activation and clears it on deactivation. This mirrors the
 * existing `OpenTaskRegistry.setConflictHandler` seam.
 */
import { Logger } from "@/shared/services/Logger"

export type TabOpener = () => Promise<void> | void

let tabOpener: TabOpener | undefined

/**
 * Registers the handler invoked to open a new editor tab; `undefined` clears it.
 * @param opener The host-provided implementation, or undefined to clear
 */
export function setTabOpener(opener: TabOpener | undefined): void {
	tabOpener = opener
}

/**
 * Asks the host to open a new Dirac EXT editor tab.
 * @returns true when an opener ran to completion, false when none is registered or it threw
 */
export async function openNewTab(): Promise<boolean> {
	if (!tabOpener) {
		// A webview button that silently does nothing is the failure we want
		// readable in the log.
		Logger.warn("No tab opener registered; cannot open a new tab")
		return false
	}

	try {
		await tabOpener()
		return true
	} catch (error) {
		// A failed tab open must not propagate as a failed gRPC call.
		Logger.error(`Failed to open new tab: ${error}`)
		return false
	}
}
