import { Empty, type EmptyRequest } from "@shared/proto/dirac/common"
import { openNewTab } from "@core/webview/tabOpener"
import type { Controller } from "../index"

/**
 * Opens a new Dirac EXT editor tab with an empty conversation
 * @param _controller The controller instance (unused)
 * @param _request An empty request
 * @returns Empty response
 *
 * The new tab is deliberately independent of the calling controller: it starts
 * an empty conversation owned by its own controller.
 */
export async function openInNewTab(_controller: Controller, _request: EmptyRequest): Promise<Empty> {
	// openNewTab already swallows and logs failures, so no try/catch here.
	await openNewTab()
	return Empty.create({})
}
