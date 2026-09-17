import { EmptyRequest, String } from "@shared/proto/dirac/common"
import { DiracWebviewProvider } from "@/core/webview"
import type { Controller } from "../index"

/**
 * Returns the HTML content of the webview.
 *
 * This is only used by the standalone service. The Vscode extension gets the HTML directly from the webview when it
 * resolved through `resolveWebviewView()`.
 */
export async function getWebviewHtml(_controller: Controller, _: EmptyRequest): Promise<String> {
	// With several instances the sidebar is "the" webview for the standalone host.
	const webview = DiracWebviewProvider.getSidebarInstance()
	if (!webview) {
		throw new Error("No Dirac sidebar webview instance is available to render HTML for.")
	}
	return Promise.resolve(String.create({ value: webview.getHtmlContent() }))
}
