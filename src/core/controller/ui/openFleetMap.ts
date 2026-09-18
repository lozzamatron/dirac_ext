import { Empty, type EmptyRequest } from "@shared/proto/dirac/common"
import { openFleetMap as openFleetMapSurface } from "@core/webview/fleetMapOpener"
import type { Controller } from "../index"

/**
 * Opens (or reveals) the Fleet Map panel.
 *
 * Dirac EXT (WP5b). The panel is a singleton — the host's opener reveals the existing one rather
 * than creating a second — so this RPC is safe to fire from every surface's strip button.
 *
 * The imported helper shares this handler's name, hence the alias: one is the RPC the webview calls,
 * the other is the host indirection it delegates to.
 * @param _controller The controller instance (unused; the fleet is not keyed by controller)
 * @param _request An empty request
 * @returns Empty response
 */
export async function openFleetMap(_controller: Controller, _request: EmptyRequest): Promise<Empty> {
	// openFleetMapSurface already swallows and logs failures, so no try/catch here.
	await openFleetMapSurface()
	return Empty.create({})
}
