import { DiracWebviewProvider } from "@/core/webview"
import { Logger } from "@/shared/services/Logger"

export const TASK_URI_PATH = "/task"

/**
 * Shared URI handler that processes both VSCode URI events and HTTP server callbacks
 */
export class SharedUriHandler {
	/**
	 * Processes a URI and routes it to the appropriate handler
	 * @param url The URI to process (can be from VSCode or converted from HTTP)
	 * @returns Promise<boolean> indicating success (true) or failure (false)
	 */
	public static async handleUri(url: string): Promise<boolean> {
		const parsedUrl = new URL(url)
		const path = parsedUrl.pathname

		// Create URLSearchParams from the query string, but preserve plus signs
		// by replacing them with a placeholder before parsing
		const queryString = parsedUrl.search.slice(1) // Remove leading '?'
		const query = new URLSearchParams(queryString.replace(/\+/g, "%2B"))

		Logger.info(
			"SharedUriHandler: Processing URI:" +
				JSON.stringify({
					path: path,
					query: query,
					scheme: parsedUrl.protocol,
				}),
		)

		// With several instances (sidebar + editor tabs) an invisible sidebar is no longer a reason to
		// drop a URI: auth callbacks belong to whichever instance started the flow, and a /task link
		// belongs to the sidebar.
		const sidebarWebview = DiracWebviewProvider.getSidebarInstance()
		const targetWebview = DiracWebviewProvider.getLastActiveInstance() ?? sidebarWebview

		if (!targetWebview) {
			Logger.warn("SharedUriHandler: No Dirac webview instance found")
			return false
		}

		try {
			switch (path) {
				case "/openrouter": {
					const code = query.get("code")
					if (code) {
						await targetWebview.controller.completeOpenRouterAuth(code)
						return true
					}
					Logger.warn("SharedUriHandler: Missing code parameter for OpenRouter callback")
					return false
				}
				case "/requesty": {
					const code = query.get("code")
					if (code) {
						await targetWebview.controller.completeRequestyAuth(code)
						return true
					}
					Logger.warn("SharedUriHandler: Missing code parameter for Requesty callback")
					return false
				}
				case TASK_URI_PATH: {
					const prompt = query.get("prompt")
					if (prompt) {
						await (sidebarWebview ?? targetWebview).controller.createTask(prompt)
						return true
					}
					Logger.warn("SharedUriHandler: Missing prompt parameter for task creation")
					return false
				}
				default:
					Logger.warn(`SharedUriHandler: Unknown path: ${path}`)
					return false
			}
		} catch (error) {
			Logger.error("SharedUriHandler: Error processing URI:", error)
			return false
		}
	}
}
