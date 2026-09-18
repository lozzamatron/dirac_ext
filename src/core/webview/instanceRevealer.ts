/**
 * Seam for bringing an existing Dirac EXT instance to the front from the fleet map.
 *
 * Core must not import `vscode`, so the host registers the actual reveal implementation at
 * activation and clears it on deactivation. This mirrors `tabOpener.ts`, which exists for the same
 * reason: the fleet handler lives in core, and "show this panel" is a host gesture.
 *
 * Resolving `false` — never throwing — covers the ordinary case of an instance that closed between
 * the snapshot the panel rendered from and the click on its Reveal button. That is not an error;
 * the next snapshot corrects the list.
 */
import { Logger } from "@/shared/services/Logger"

export type InstanceRevealer = (instanceId: string) => Promise<boolean>

let instanceRevealer: InstanceRevealer | undefined

/**
 * Registers the handler invoked to reveal an instance; `undefined` clears it.
 * @param revealer The host-provided implementation, or undefined to clear
 */
export function setInstanceRevealer(revealer: InstanceRevealer | undefined): void {
	instanceRevealer = revealer
}

/**
 * Asks the host to bring the instance with the given id to the front, re-attaching it first if it
 * is detached.
 * @returns true when the instance was revealed (or re-attached), false when it no longer exists,
 *   when none is registered, or when the revealer threw
 */
export async function revealInstance(instanceId: string): Promise<boolean> {
	if (!instanceRevealer) {
		// A Reveal button that silently does nothing is the failure we want readable in the log.
		Logger.warn("No instance revealer registered; cannot reveal instance")
		return false
	}

	try {
		return await instanceRevealer(instanceId)
	} catch (error) {
		// A failed reveal must not propagate as a failed gRPC call.
		Logger.error(`Failed to reveal instance ${instanceId}: ${error}`)
		return false
	}
}
