import { Boolean } from "@shared/proto/dirac/common"
import type { StringRequest } from "@shared/proto/dirac/common"
// Aliased because the exported gRPC handler below has the same name as the helper it delegates to —
// the service method and the host indirection are two different things that describe the same
// gesture, and an unaliased import would shadow one with the other.
import { revealInstance as revealInstanceOnHost } from "@core/webview/instanceRevealer"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"

/**
 * Brings a fleet-listed instance to the front, re-attaching it first if it is detached.
 *
 * Resolving `false` is the ORDINARY case for an instance that closed between the snapshot the panel
 * rendered from and the click on its Reveal button — not an error; the next snapshot (≤750ms)
 * corrects the list, and the webview shows nothing beyond leaving the card in place. Whether a
 * detached instance is re-attached before being revealed is decided by the host implementation
 * registered with `setInstanceRevealer`, not here.
 *
 * @param _controller The controller instance. Unused: the fleet is not keyed by controller, but the
 *   gRPC handler's signature passes it to every service method.
 * @param request The request carrying the instance id in `value`
 * @returns true when the instance was revealed (or re-attached), false when the id was empty, the
 *   instance no longer exists, or the host reveal failed
 */
export async function revealInstance(_controller: Controller, request: StringRequest): Promise<Boolean> {
	const instanceId = request.value
	if (!instanceId) {
		// A caller that had nothing to ask about — not an error, but worth reading in the log.
		Logger.warn("revealInstance called with an empty instance id")
		return Boolean.create({ value: false })
	}

	const revealed = await revealInstanceOnHost(instanceId)
	return Boolean.create({ value: revealed })
}
