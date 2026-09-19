/**
 * ACP Host Bridge Client Provider
 *
 * Implements HostBridgeClientProvider for ACP mode. File editing is handled by
 * FileEditProvider with ACPTextFileAccess; the diff client provides truthful
 * protocol presentation or rejects legacy document-editor operations.
 *
 * @module acp
 */

import { randomUUID } from "node:crypto"
import type * as acp from "@agentclientprotocol/sdk"
import type {
	DiffServiceClientInterface,
	EnvServiceClientInterface,
	WindowServiceClientInterface,
	WorkspaceServiceClientInterface,
} from "@generated/hosts/host-bridge-client-types"
import type { HostBridgeClientProvider, StreamingCallbacks } from "@hosts/host-provider-types"
import * as proto from "@shared/proto/index"
import { DiracClient } from "@/shared/dirac"
import { Logger } from "@/shared/services/Logger"
import { requireActiveAcpSessionId, type ActiveAcpSessionIdResolver } from "./active-session.js"

export type AcpSessionUpdateEmitter = (sessionId: string, update: acp.SessionUpdate) => Promise<void>

function invalidLegacyDiffOperation(operation: string): Error {
	return new Error(
		`ACP host diff document operation "${operation}" is not the ACP file-editing path. Use FileEditProvider with ACPTextFileAccess.`,
	)
}

/**
 * Function type that resolves the current working directory.
 * Returns undefined if no cwd is available (will fall back to process.cwd()).
 */
export type CwdResolver = () => string | undefined

class ACPDiffServiceClient implements DiffServiceClientInterface {
	constructor(
		private readonly sessionIdResolver: ActiveAcpSessionIdResolver,
		private readonly emitSessionUpdate: AcpSessionUpdateEmitter | undefined,
	) {}

	async openDiff(_request: proto.host.OpenDiffRequest): Promise<proto.host.OpenDiffResponse> {
		throw invalidLegacyDiffOperation("openDiff")
	}

	async getDocumentText(_request: proto.host.GetDocumentTextRequest): Promise<proto.host.GetDocumentTextResponse> {
		throw invalidLegacyDiffOperation("getDocumentText")
	}

	async replaceText(_request: proto.host.ReplaceTextRequest): Promise<proto.host.ReplaceTextResponse> {
		throw invalidLegacyDiffOperation("replaceText")
	}

	async scrollDiff(_request: proto.host.ScrollDiffRequest): Promise<proto.host.ScrollDiffResponse> {
		throw invalidLegacyDiffOperation("scrollDiff")
	}

	async truncateDocument(_request: proto.host.TruncateDocumentRequest): Promise<proto.host.TruncateDocumentResponse> {
		throw invalidLegacyDiffOperation("truncateDocument")
	}

	async saveDocument(_request: proto.host.SaveDocumentRequest): Promise<proto.host.SaveDocumentResponse> {
		throw invalidLegacyDiffOperation("saveDocument")
	}

	async closeAllDiffs(_request: proto.host.CloseAllDiffsRequest): Promise<proto.host.CloseAllDiffsResponse> {
		throw invalidLegacyDiffOperation("closeAllDiffs")
	}

	async openMultiFileDiff(request: proto.host.OpenMultiFileDiffRequest): Promise<proto.host.OpenMultiFileDiffResponse> {
		const sessionId = requireActiveAcpSessionId(this.sessionIdResolver, "presenting a multi-file diff")
		if (request.diffs.length === 0) {
			throw new Error("Cannot present an ACP multi-file diff without at least one diff.")
		}
		if (!this.emitSessionUpdate) {
			throw new Error("Cannot present an ACP multi-file diff without a session update emitter.")
		}

		const diffs = request.diffs.map((diff) => {
			const path = diff.filePath
			if (!path?.trim()) {
				throw new Error("Cannot present an ACP multi-file diff with a missing file path.")
			}
			return {
				path,
				oldText: diff.leftContent ?? "",
				newText: diff.rightContent ?? "",
			}
		})

		await this.emitSessionUpdate(sessionId, {
			sessionUpdate: "tool_call",
			toolCallId: randomUUID(),
			name: "open_multi_file_diff",
			title: request.title || "Review changes",
			kind: "edit",
			status: "completed",
			content: diffs.map((diff) => ({ type: "diff", ...diff })),
			locations: diffs.map((diff) => ({ path: diff.path })),
			rawInput: {
				title: request.title,
				fileCount: diffs.length,
			},
		})

		return proto.host.OpenMultiFileDiffResponse.create({})
	}
}

/**
 * ACP implementation of EnvService client.
 *
 * Handles environment operations like clipboard access, version info, and telemetry.
 * Most operations are stubs that will be implemented using ACP extension methods.
 */
class ACPEnvServiceClient implements EnvServiceClientInterface {
	private readonly version: string

	constructor(
		_clientCapabilities: acp.ClientCapabilities | undefined,
		_sessionIdResolver: ActiveAcpSessionIdResolver,
		version: string,
	) {
		this.version = version
	}

	async debugLog(request: proto.dirac.StringRequest): Promise<proto.dirac.Empty> {
		Logger.debug(request.value)
		return proto.dirac.Empty.create()
	}

	async clipboardWriteText(_request: proto.dirac.StringRequest): Promise<proto.dirac.Empty> {
		Logger.debug("[ACPEnvServiceClient] clipboardWriteText called (stub)")
		return proto.dirac.Empty.create()
	}

	async clipboardReadText(_request: proto.dirac.EmptyRequest): Promise<proto.dirac.String> {
		Logger.debug("[ACPEnvServiceClient] clipboardReadText called (stub)")
		return proto.dirac.String.create({ value: "" })
	}

	async getHostVersion(_request: proto.dirac.EmptyRequest): Promise<proto.host.GetHostVersionResponse> {
		// Return version info for the ACP agent.
		return proto.host.GetHostVersionResponse.create({
			version: this.version,
			platform: "Dirac ACP Agent",
			diracType: DiracClient.Cli,
		})
	}

	async getIdeRedirectUri(_request: proto.dirac.EmptyRequest): Promise<proto.dirac.String> {
		Logger.debug("[ACPEnvServiceClient] getIdeRedirectUri called (stub)")
		return proto.dirac.String.create({ value: "" })
	}

	async getTelemetrySettings(_request: proto.dirac.EmptyRequest): Promise<proto.host.GetTelemetrySettingsResponse> {
		// Return telemetry as disabled by default in ACP mode.
		return proto.host.GetTelemetrySettingsResponse.create({
			isEnabled: proto.host.Setting.DISABLED,
		})
	}

	subscribeToTelemetrySettings(
		_request: proto.dirac.EmptyRequest,
		callbacks: StreamingCallbacks<proto.host.TelemetrySettingsEvent>,
	): () => void {
		// Send initial telemetry settings (disabled) and return unsubscribe function.
		callbacks.onResponse(
			proto.host.TelemetrySettingsEvent.create({
				isEnabled: proto.host.Setting.DISABLED,
			}),
		)
		// Return no-op unsubscribe function
		return () => {}
	}

	async shutdown(_request: proto.dirac.EmptyRequest): Promise<proto.dirac.Empty> {
		// Next phase: Graceful ACP connection shutdown.
		// This would cleanly close the ACP connection and release resources.
		Logger.debug("[ACPEnvServiceClient] shutdown called (stub)")
		return proto.dirac.Empty.create()
	}

	async openExternal(request: proto.dirac.StringRequest): Promise<proto.dirac.Empty> {
		const url = request.value || ""
		if (url) {
			Logger.debug(`[ACPEnvServiceClient] openExternal: ${url}`)
			const { openUrlInBrowser } = await import("../utils/browser")
			await openUrlInBrowser(url)
		}
		return proto.dirac.Empty.create()
	}
}

/**
 * ACP implementation of WindowService client.
 *
 * Handles window/UI operations like showing documents, dialogs, and messages.
 * Most operations are stubs that will be implemented using ACP extension methods.
 */
class ACPWindowServiceClient implements WindowServiceClientInterface {
	constructor(_clientCapabilities: acp.ClientCapabilities | undefined, _sessionIdResolver: ActiveAcpSessionIdResolver) {}

	async showTextDocument(request: proto.host.ShowTextDocumentRequest): Promise<proto.host.TextEditorInfo> {
		// Next phase: Send ACP extension request to open document in the editor.
		// This would tell the ACP client to open the specified file.
		Logger.debug("[ACPWindowServiceClient] showTextDocument called (stub)", { path: request.path })
		return proto.host.TextEditorInfo.create({
			documentPath: request.path,
		})
	}

	async showOpenDialogue(_request: proto.host.ShowOpenDialogueRequest): Promise<proto.host.SelectedResources> {
		// Next phase: Send ACP extension request for file picker dialog.
		// This would display a file open dialog in the ACP client.
		Logger.debug("[ACPWindowServiceClient] showOpenDialogue called (stub)")
		return proto.host.SelectedResources.create({ paths: [] })
	}

	async showMessage(request: proto.host.ShowMessageRequest): Promise<proto.host.SelectedResponse> {
		// Next phase: Send ACP extension notification to show message in the editor.
		// This would display an information/warning/error message to the user.
		Logger.debug("[ACPWindowServiceClient] showMessage called (stub)", {
			message: request.message,
			type: request.type,
		})
		return proto.host.SelectedResponse.create({})
	}

	async showInputBox(_request: proto.host.ShowInputBoxRequest): Promise<proto.host.ShowInputBoxResponse> {
		// Next phase: Send ACP extension request for input dialog.
		// This would display an input box for user text entry.
		Logger.debug("[ACPWindowServiceClient] showInputBox called (stub)")
		return proto.host.ShowInputBoxResponse.create({ response: "" })
	}

	async showSaveDialog(_request: proto.host.ShowSaveDialogRequest): Promise<proto.host.ShowSaveDialogResponse> {
		// Next phase: Send ACP extension request for save dialog.
		// This would display a file save dialog in the ACP client.
		Logger.debug("[ACPWindowServiceClient] showSaveDialog called (stub)")
		return proto.host.ShowSaveDialogResponse.create({ selectedPath: "" })
	}

	async openFile(request: proto.host.OpenFileRequest): Promise<proto.host.OpenFileResponse> {
		// Next phase: Send ACP extension request to open file in the editor.
		// This would open the specified file in the ACP client's editor.
		Logger.debug("[ACPWindowServiceClient] openFile called (stub)", { filePath: request.filePath })
		return proto.host.OpenFileResponse.create({})
	}

	async openSettings(_request: proto.host.OpenSettingsRequest): Promise<proto.host.OpenSettingsResponse> {
		// Next phase: Send ACP extension request to open settings panel.
		// This would open the settings/preferences in the ACP client.
		return proto.host.OpenSettingsResponse.create({})
	}

	async getOpenTabs(_request: proto.host.GetOpenTabsRequest): Promise<proto.host.GetOpenTabsResponse> {
		// Next phase: Send ACP extension request to list open tabs/documents.
		// This would return a list of currently open files in the editor.
		return proto.host.GetOpenTabsResponse.create({ paths: [] })
	}

	async getVisibleTabs(_request: proto.host.GetVisibleTabsRequest): Promise<proto.host.GetVisibleTabsResponse> {
		// Next phase: Send ACP extension request to list visible tabs.
		// This would return a list of visible tabs/panes in the editor.
		return proto.host.GetVisibleTabsResponse.create({ paths: [] })
	}

	async getActiveEditor(_request: proto.host.GetActiveEditorRequest): Promise<proto.host.GetActiveEditorResponse> {
		// Next phase: Send ACP extension request to get active editor info.
		// This would return information about the currently focused editor.
		return proto.host.GetActiveEditorResponse.create({})
	}
}

/**
 * ACP implementation of WorkspaceService client.
 *
 * Handles workspace operations like getting paths, diagnostics, and terminal commands.
 * Uses the cwdResolver to get the current working directory, falling back to process.cwd().
 */
class ACPWorkspaceServiceClient implements WorkspaceServiceClientInterface {
	private readonly _clientCapabilities: acp.ClientCapabilities | undefined
	private readonly cwdResolver: CwdResolver

	constructor(
		clientCapabilities: acp.ClientCapabilities | undefined,
		_sessionIdResolver: ActiveAcpSessionIdResolver,
		cwdResolver: CwdResolver,
	) {
		this._clientCapabilities = clientCapabilities
		this.cwdResolver = cwdResolver
	}

	/**
	 * Get the current working directory, using the resolver if available,
	 * otherwise falling back to process.cwd().
	 */
	private getCwd(): string {
		return this.cwdResolver() ?? process.cwd()
	}

	async getWorkspacePaths(_request: proto.host.GetWorkspacePathsRequest): Promise<proto.host.GetWorkspacePathsResponse> {
		// Return the current working directory from the resolver.
		const cwd = this.getCwd()
		Logger.debug("[ACPWorkspaceServiceClient] getWorkspacePaths called", { cwd })
		return proto.host.GetWorkspacePathsResponse.create({
			paths: [cwd],
		})
	}

	async saveOpenDocumentIfDirty(
		_request: proto.host.SaveOpenDocumentIfDirtyRequest,
	): Promise<proto.host.SaveOpenDocumentIfDirtyResponse> {
		const canReadAndWriteThroughClient =
			this._clientCapabilities?.fs?.readTextFile === true &&
			this._clientCapabilities.fs.writeTextFile === true
		if (!canReadAndWriteThroughClient) {
			throw new Error(
				"ACP file editing requires negotiated fs.readTextFile and fs.writeTextFile capabilities to avoid overwriting unsaved editor content.",
			)
		}

		// ACP file reads observe the client's authoritative buffer, and ACP writes
		// update that same client-owned file state, so no separate save is needed.
		return proto.host.SaveOpenDocumentIfDirtyResponse.create({})
	}

	async getDiagnostics(_request: proto.host.GetDiagnosticsRequest): Promise<proto.host.GetDiagnosticsResponse> {
		// Next phase: Send ACP extension request for diagnostics (errors, warnings).
		// This would return linting/compilation errors from the ACP client.
		Logger.debug("[ACPWorkspaceServiceClient] getDiagnostics called (stub)")
		return proto.host.GetDiagnosticsResponse.create({ fileDiagnostics: [] })
	}

	async getCallHierarchy(_request: proto.host.GetCallHierarchyRequest): Promise<proto.host.GetCallHierarchyResponse> {
		// Dirac EXT (WP7): ACP has no call-hierarchy extension request, so there is no language server
		// to ask. Report that plainly — an empty node list would read as "this symbol has no callers",
		// which is a finding, not an absence of one.
		Logger.debug("[ACPWorkspaceServiceClient] getCallHierarchy called (stub)")
		return proto.host.GetCallHierarchyResponse.create({
			resolved: false,
			unresolvedReason: "Call hierarchy is unavailable over ACP: no language server is reachable from this host.",
			nodes: [],
		})
	}

	async openProblemsPanel(_request: proto.host.OpenProblemsPanelRequest): Promise<proto.host.OpenProblemsPanelResponse> {
		// Next phase: Send ACP extension notification to open the problems panel.
		// This would show the diagnostics/problems view in the editor.
		Logger.debug("[ACPWorkspaceServiceClient] openProblemsPanel called (stub)")
		return proto.host.OpenProblemsPanelResponse.create({})
	}

	async openInFileExplorerPanel(
		request: proto.host.OpenInFileExplorerPanelRequest,
	): Promise<proto.host.OpenInFileExplorerPanelResponse> {
		// Next phase: Send ACP extension notification to reveal file in explorer.
		// This would highlight/reveal the specified path in the file tree.
		Logger.debug("[ACPWorkspaceServiceClient] openInFileExplorerPanel called (stub)", { path: request.path })
		return proto.host.OpenInFileExplorerPanelResponse.create({})
	}

	async openDiracSidebarPanel(
		_request: proto.host.OpenDiracSidebarPanelRequest,
	): Promise<proto.host.OpenDiracSidebarPanelResponse> {
		// Next phase: Send ACP extension notification to open Dirac sidebar.
		// This would show the Dirac panel/sidebar in the editor.
		Logger.debug("[ACPWorkspaceServiceClient] openDiracSidebarPanel called (stub)")
		return proto.host.OpenDiracSidebarPanelResponse.create({})
	}

	async openTerminalPanel(_request: proto.host.OpenTerminalRequest): Promise<proto.host.OpenTerminalResponse> {
		// Next phase: Send ACP extension notification or use createTerminal capability.
		// This would open/show the terminal panel in the editor.
		Logger.debug("[ACPWorkspaceServiceClient] openTerminalPanel called (stub)")
		return proto.host.OpenTerminalResponse.create({})
	}

	async executeCommandInTerminal(
		request: proto.host.ExecuteCommandInTerminalRequest,
	): Promise<proto.host.ExecuteCommandInTerminalResponse> {
		// Next phase: Use connection.createTerminal if clientCapabilities.terminal is available.
		// This would execute the specified command in a terminal via the ACP client.
		// The ACP SDK provides createTerminal() which returns a TerminalHandle with
		// methods like currentOutput(), waitForExit(), kill(), and release().
		Logger.debug("[ACPWorkspaceServiceClient] executeCommandInTerminal called (stub)", {
			command: request.command,
			hasTerminalCapability: this._clientCapabilities?.terminal,
		})
		return proto.host.ExecuteCommandInTerminalResponse.create({})
	}

	async prepareDiagnostics(_request: proto.host.PrepareDiagnosticsRequest): Promise<proto.host.PrepareDiagnosticsResponse> {
		return proto.host.PrepareDiagnosticsResponse.create({ success: true })
	}

	async openFolder(request: proto.host.OpenFolderRequest): Promise<proto.host.OpenFolderResponse> {
		// Next phase: Send ACP extension request to change workspace/folder.
		// This would open a new folder/workspace in the ACP client.
		Logger.debug("[ACPWorkspaceServiceClient] openFolder called (stub)", { path: request.path })
		return proto.host.OpenFolderResponse.create({ success: true })
	}
}

/**
 * ACP Host Bridge Client Provider
 *
 * Provides the 4 service clients required by HostBridgeClientProvider interface,
 * implemented for the ACP environment. Uses the ACP connection and client capabilities
 * to delegate operations to the ACP client where possible.
 */
export class ACPHostBridgeClientProvider implements HostBridgeClientProvider {
	workspaceClient: WorkspaceServiceClientInterface
	envClient: EnvServiceClientInterface
	windowClient: WindowServiceClientInterface
	diffClient: DiffServiceClientInterface

	/**
	 * Creates a new ACPHostBridgeClientProvider.
	 *
	 * @param connection - The ACP agent-side connection for making requests
	 * @param clientCapabilities - The client's advertised capabilities
	 * @param sessionIdResolver - Function that returns the current session ID
	 * @param cwdResolver - Function that returns the current working directory
	 * @param emitSessionUpdate - Optional session-update delivery callback
	 * @param version - Version string for getHostVersion
	 */
	constructor(
		connection: acp.AgentSideConnection | undefined,
		clientCapabilities: acp.ClientCapabilities | undefined,
		sessionIdResolver: ActiveAcpSessionIdResolver,
		cwdResolver: CwdResolver,
		emitSessionUpdate: AcpSessionUpdateEmitter | undefined,
		version: string,
	) {
		const sessionUpdateEmitter =
			emitSessionUpdate ??
			(connection
				? async (sessionId: string, update: acp.SessionUpdate) => connection.sessionUpdate({ sessionId, update })
				: undefined)
		this.workspaceClient = new ACPWorkspaceServiceClient(clientCapabilities, sessionIdResolver, cwdResolver)
		this.envClient = new ACPEnvServiceClient(clientCapabilities, sessionIdResolver, version)
		this.windowClient = new ACPWindowServiceClient(clientCapabilities, sessionIdResolver)
		this.diffClient = new ACPDiffServiceClient(sessionIdResolver, sessionUpdateEmitter)
	}
}
