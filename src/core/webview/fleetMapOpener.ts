// Dirac EXT (WP5b): the webview's "fleet map" button reaches the host through the openFleetMap RPC,
// and the core handler must not know about VS Code — so the host supplies the implementation here,
// exactly the way `tabOpener.ts` supplies the "new tab" one, and clears it on deactivation.
import { Logger } from "@/shared/services/Logger"

/** Opens (or reveals) the host's single fleet-map surface. */
export type FleetMapOpener = () => Promise<void>

let opener: FleetMapOpener | undefined

/**
 * Registers the host's fleet-map opener, or clears it with `undefined` on deactivation.
 * @param fn The host implementation, or undefined to clear
 */
export function setFleetMapOpener(fn: FleetMapOpener | undefined): void {
	opener = fn
}

/**
 * Asks the host to open the fleet map.
 *
 * Resolves `false` rather than throwing when no opener is registered or the opener rejects: the
 * button is in a webview, and a rejected RPC there surfaces as an unhandled console error the user
 * cannot act on. `false` lets the caller stay quiet about a surface the host declined to open.
 * @returns True when the host opened it
 */
export async function openFleetMap(): Promise<boolean> {
	if (!opener) {
		Logger.warn("[fleetMapOpener] No fleet map opener registered; ignoring the request")
		return false
	}
	try {
		await opener()
		return true
	} catch (error) {
		Logger.error("[fleetMapOpener] Failed to open the fleet map:", error)
		return false
	}
}
