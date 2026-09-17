// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below

import assert from "node:assert"
import { DIFF_VIEW_URI_SCHEME } from "@hosts/vscode/diff-view-constants"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import { sendChatButtonClickedEvent } from "./core/controller/ui/subscribeToChatButtonClicked"
import { sendHistoryButtonClickedEvent } from "./core/controller/ui/subscribeToHistoryButtonClicked"
import { sendSettingsButtonClickedEvent } from "./core/controller/ui/subscribeToSettingsButtonClicked"
import { sendWorktreesButtonClickedEvent } from "./core/controller/ui/subscribeToWorktreesButtonClicked"
import { DiracWebviewProvider } from "./core/webview"
import { createDiracAPI } from "./exports"
import { initializeTestMode } from "./services/test/TestMode"
import { DiracAskResponse } from "./shared/WebviewMessage"
import "./utils/path" // necessary to have access to String.prototype.toPosix
import { isDev } from "@shared/config/environment"
import type { ExtensionContext } from "vscode"
import { HostProvider } from "@/hosts/host-provider"
import { vscodeHostBridgeClient } from "@/hosts/vscode/hostbridge/client/host-grpc-client"
import { getErrorMessage, toError } from "@/shared/errors"
import { createStorageContext } from "@/shared/storage/storage-context"
import { readTextFromClipboard, writeTextToClipboard } from "@/utils/env"
import { initialize, tearDown } from "./common"
import { addToDirac } from "./core/controller/commands/addToDirac"
import { explainWithDirac } from "./core/controller/commands/explainWithDirac"
import { fixWithDirac } from "./core/controller/commands/fixWithDirac"
import { improveWithDirac } from "./core/controller/commands/improveWithDirac"
import { sendAddToInputEvent } from "./core/controller/ui/subscribeToAddToInput"
import { sendShowWebviewEvent } from "./core/controller/ui/subscribeToShowWebview"
import { HookDiscoveryCache } from "./core/hooks/HookDiscoveryCache"
import {
	cleanupOldApiKey,
	migrateCustomInstructionsToGlobalRules,
	migrateTaskHistoryToFile,
	migrateWelcomeViewCompleted,
	migrateWorkspaceToGlobalStorage,
} from "./core/storage/state-migrations"
import { findMatchingNotebookCell, getContextForCommand, showWebview } from "./hosts/vscode/commandUtils"
import { abortCommitGeneration, generateCommitMsg } from "./hosts/vscode/commit-message-generator"
import { registerDiracOutputChannel } from "./hosts/vscode/hostbridge/env/debugLog"
import {
	disposeVscodeCommentReviewController,
	getVscodeCommentReviewController,
} from "./hosts/vscode/review/VscodeCommentReviewController"
import { VscodeTerminalManager } from "./hosts/vscode/terminal/VscodeTerminalManager"
import { VscodeDiffViewProvider } from "./hosts/vscode/VscodeDiffViewProvider"
import type { WebviewSurface } from "@core/webview/InstanceRegistry"
import { VscodeDiracWebviewProvider } from "./hosts/vscode/VscodeWebviewProvider"
import { exportVSCodeStorageToSharedFiles } from "./hosts/vscode/vscode-to-file-migration"
import { ExtensionRegistryInfo } from "./registry"
import { resolveWorkingRipgrepBinary } from "./services/ripgrep/resolve-ripgrep-binary"
import { telemetryService } from "./services/telemetry"
import { SharedUriHandler, TASK_URI_PATH } from "./services/uri/SharedUriHandler"
import { ShowMessageType } from "./shared/proto/host/window"
import { openTasks } from "@core/task/OpenTaskRegistry"
import { setTabOpener } from "@core/webview/tabOpener"
import { TaskStatus } from "@shared/ExtensionMessage"

// This method is called when the VS Code extension is activated.
// NOTE: This is VS Code specific - services that should be registered
// for all-platform should be registered in common.ts.
export async function activate(context: vscode.ExtensionContext) {
	const activationStartTime = performance.now()

	// 1. Create storage context to determine shared data directory
	const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	const storageContext = createStorageContext({ workspacePath })

	// 2. Set up HostProvider for VSCode using shared data directory
	// IMPORTANT: This must be done before any service can be registered
	await setupHostProvider(context, storageContext.dataDir)

	// 3. Clean up legacy data patterns within VSCode's native storage.
	// Moves workspace→global keys, task history→file, custom instructions→rules, etc.
	// Must run BEFORE the file export so we copy clean state.
	await cleanupLegacyVSCodeStorage(context)

	// 4. One-time export of VSCode's native storage to shared file-backed stores.
	// After this, all platforms (VSCode, CLI, JetBrains) read from ~/.dirac/data/.
	await exportVSCodeStorageToSharedFiles(context, storageContext)

	// 4. Register services and perform common initialization
	// IMPORTANT: Must be done after host provider is setup and migrations are complete
	const webview = (await initialize(storageContext)) as VscodeDiracWebviewProvider

	// 5. Register services and commands specific to VS Code
	// Initialize test mode and add disposables to context
	const testModeWatchers = await initializeTestMode(webview)
	context.subscriptions.push(...testModeWatchers)

	// Initialize hook discovery cache for performance optimization
	HookDiscoveryCache.getInstance().initialize(
		{ subscriptions: context.subscriptions },
		(dir: string) => {
			try {
				const pattern = new vscode.RelativePattern(dir, "*")
				const watcher = vscode.workspace.createFileSystemWatcher(pattern)
				// Ensure watcher is disposed when extension is deactivated
				context.subscriptions.push(watcher)
				// Adapt VSCode FileSystemWatcher to generic interface
				return {
					onDidCreate: (listener: () => void) => watcher.onDidCreate(listener),
					onDidChange: (listener: () => void) => watcher.onDidChange(listener),
					onDidDelete: (listener: () => void) => watcher.onDidDelete(listener),
					dispose: () => watcher.dispose(),
				}
			} catch {
				return null
			}
		},
		(callback: () => void) => {
			// Adapt VSCode Disposable to generic interface
			const disposable = vscode.workspace.onDidChangeWorkspaceFolders(callback)
			context.subscriptions.push(disposable)
			return disposable
		},
	)

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(VscodeDiracWebviewProvider.SIDEBAR_ID, webview, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	)

	// NOTE: Commands must be added to the internal registry before registering them with VSCode
	const { commands } = ExtensionRegistryInfo

	context.subscriptions.push(
		vscode.commands.registerCommand(commands.PlusButton, async () => {
			const sidebarInstance = DiracWebviewProvider.getSidebarInstance()
			if (!sidebarInstance) {
				Logger.warn("New Task command: no sidebar instance available")
				return
			}
			await sidebarInstance.controller.clearTask()
			await sidebarInstance.controller.postStateToWebview()
			await sendChatButtonClickedEvent(sidebarInstance.controller.id)
		}),
	)

	const resolveTargetInstance = () => DiracWebviewProvider.getLastActiveInstance() ?? DiracWebviewProvider.getSidebarInstance()

	context.subscriptions.push(
		vscode.commands.registerCommand(commands.SettingsButton, () => {
			const instance = resolveTargetInstance()
			if (!instance) {
				Logger.warn("Settings button: no webview instance available")
				return
			}
			sendSettingsButtonClickedEvent(instance.controller.id)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.HistoryButton, () => {
			const instance = resolveTargetInstance()
			if (!instance) {
				Logger.warn("History button: no webview instance available")
				return
			}
			sendHistoryButtonClickedEvent(instance.controller.id)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.WorktreesButton, () => {
			const instance = resolveTargetInstance()
			if (!instance) {
				Logger.warn("Worktrees button: no webview instance available")
				return
			}
			sendWorktreesButtonClickedEvent(instance.controller.id)
		}),
	)

	/*
	We use the text document content provider API to show the left side for diff view by creating a
	virtual document for the original content. This makes it readonly so users know to edit the right
	side if they want to keep their changes.

	- This API allows you to create readonly documents in VSCode from arbitrary sources, and works by
	claiming an uri-scheme for which your provider then returns text contents. The scheme must be
	provided when registering a provider and cannot change afterwards.
	- Note how the provider doesn't create uris for virtual documents - its role is to provide contents
	 given such an uri. In return, content providers are wired into the open document logic so that
	 providers are always considered.
	https://code.visualstudio.com/api/extension-guides/virtual-documents
	*/
	const diffContentProvider = new (class implements vscode.TextDocumentContentProvider {
		provideTextDocumentContent(uri: vscode.Uri): string {
			return Buffer.from(uri.query, "base64").toString("utf-8")
		}
	})()
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_VIEW_URI_SCHEME, diffContentProvider))
	// Register commands for Accept/Reject from CodeLens
	context.subscriptions.push(
		vscode.commands.registerCommand("dirac-ext.acceptEdit", async () => {
			const instance = resolveTargetInstance()
			if (!instance) {
				Logger.warn("Accept edit: no webview instance available")
				return
			}
			if (instance.controller?.task) {
				await instance.controller.task.submitCardResponse("", DiracAskResponse.APPROVE)
			}
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("dirac-ext.saveWithMyChanges", async () => {
			const instance = resolveTargetInstance()
			if (!instance) {
				Logger.warn("Save with my changes: no webview instance available")
				return
			}
			if (instance.controller?.task) {
				await instance.controller.task.submitCardResponse("", DiracAskResponse.APPROVE)
			}
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand("dirac-ext.rejectEdit", async () => {
			const instance = resolveTargetInstance()
			if (!instance) {
				Logger.warn("Reject edit: no webview instance available")
				return
			}
			if (instance.controller?.task) {
				await instance.controller.task.submitCardResponse("", DiracAskResponse.REJECT)
			}
		}),
	)

	const handleUri = async (uri: vscode.Uri) => {
		const url = decodeURIComponent(uri.toString())
		const isTaskUri = getUriPath(url) === TASK_URI_PATH

		if (isTaskUri) {
			await openDiracSidebarForTaskUri()
		}

		let success = await SharedUriHandler.handleUri(url)

		// Task deeplinks can race with first-time sidebar initialization.
		if (!success && isTaskUri) {
			await openDiracSidebarForTaskUri()
			success = await SharedUriHandler.handleUri(url)
		}

		if (!success) {
			Logger.warn("Extension URI handler: Failed to process URI:", uri.toString())
		}
	}
	context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }))

	// Register size testing commands in development mode
	if (IS_DEV) {
		vscode.commands.executeCommand("setContext", "dirac.isDevMode", IS_DEV)
		// Use dynamic import to avoid loading the module in production
		import("./dev/commands/tasks")
			.then((module) => {
				const devTaskCommands = module.registerTaskCommands(webview.controller)
				context.subscriptions.push(...devTaskCommands)
				Logger.log("[Dirac Dev] Dev mode activated & dev commands registered")
			})
			.catch((error) => {
				Logger.log("[Dirac Dev] Failed to register dev commands: " + error)
			})
	}

	context.subscriptions.push(
		vscode.commands.registerCommand(commands.TerminalOutput, async () => {
			const terminal = vscode.window.activeTerminal
			if (!terminal) {
				return
			}

			// Save current clipboard content
			const tempCopyBuffer = await readTextFromClipboard()

			try {
				// Copy the *existing* terminal selection (without selecting all)
				await vscode.commands.executeCommand("workbench.action.terminal.copySelection")

				// Get copied content
				const terminalContents = (await readTextFromClipboard()).trim()

				// Restore original clipboard content
				await writeTextToClipboard(tempCopyBuffer)

				if (!terminalContents) {
					// No terminal content was copied (either nothing selected or some error)
					return
				}
				// Ensure the sidebar view is visible but preserve editor focus
				const instance = await showWebview(true)

				await sendAddToInputEvent(instance.controller.id, `Terminal output:\n\`\`\`\n${terminalContents}\n\`\`\``)

				Logger.log("addSelectedTerminalOutputToChat", terminalContents, terminal.name)
			} catch (error) {
				// Ensure clipboard is restored even if an error occurs
				await writeTextToClipboard(tempCopyBuffer)
				Logger.error("Error getting terminal contents:", error)
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: "Failed to get terminal contents",
				})
			}
		}),
	)

	// Register code action provider
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			"*",
			new (class implements vscode.CodeActionProvider {
				public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Refactor]

				provideCodeActions(
					document: vscode.TextDocument,
					range: vscode.Range,
					context: vscode.CodeActionContext,
				): vscode.CodeAction[] {
					const CONTEXT_LINES_TO_EXPAND = 3
					const START_OF_LINE_CHAR_INDEX = 0
					const LINE_COUNT_ADJUSTMENT_FOR_ZERO_INDEXING = 1

					const actions: vscode.CodeAction[] = []
					const editor = vscode.window.activeTextEditor // Get active editor for selection check

					// Expand range to include surrounding 3 lines or use selection if broader
					const selection = editor?.selection
					let expandedRange = range
					if (
						editor &&
						selection &&
						!selection.isEmpty &&
						selection.contains(range.start) &&
						selection.contains(range.end)
					) {
						expandedRange = selection
					} else {
						expandedRange = new vscode.Range(
							Math.max(0, range.start.line - CONTEXT_LINES_TO_EXPAND),
							START_OF_LINE_CHAR_INDEX,
							Math.min(
								document.lineCount - LINE_COUNT_ADJUSTMENT_FOR_ZERO_INDEXING,
								range.end.line + CONTEXT_LINES_TO_EXPAND,
							),
							document.lineAt(
								Math.min(
									document.lineCount - LINE_COUNT_ADJUSTMENT_FOR_ZERO_INDEXING,
									range.end.line + CONTEXT_LINES_TO_EXPAND,
								),
							).text.length,
						)
					}

					// Add to Dirac (Always available)
					const addAction = new vscode.CodeAction("Add to Dirac", vscode.CodeActionKind.QuickFix)
					addAction.command = {
						command: commands.AddToChat,
						title: "Add to Dirac",
						arguments: [expandedRange, context.diagnostics],
					}
					actions.push(addAction)

					// Explain with Dirac (Always available)
					const explainAction = new vscode.CodeAction("Explain with Dirac", vscode.CodeActionKind.RefactorExtract) // Using a refactor kind
					explainAction.command = {
						command: commands.ExplainCode,
						title: "Explain with Dirac",
						arguments: [expandedRange],
					}
					actions.push(explainAction)

					// Improve with Dirac (Always available)
					const improveAction = new vscode.CodeAction("Improve with Dirac", vscode.CodeActionKind.RefactorRewrite) // Using a refactor kind
					improveAction.command = {
						command: commands.ImproveCode,
						title: "Improve with Dirac",
						arguments: [expandedRange],
					}
					actions.push(improveAction)

					// Fix with Dirac (Only if diagnostics exist)
					if (context.diagnostics.length > 0) {
						const fixAction = new vscode.CodeAction("Fix with Dirac", vscode.CodeActionKind.QuickFix)
						fixAction.isPreferred = true
						fixAction.command = {
							command: commands.FixWithDirac,
							title: "Fix with Dirac",
							arguments: [expandedRange, context.diagnostics],
						}
						actions.push(fixAction)
					}
					return actions
				}
			})(),
			{
				providedCodeActionKinds: [
					vscode.CodeActionKind.QuickFix,
					vscode.CodeActionKind.RefactorExtract,
					vscode.CodeActionKind.RefactorRewrite,
				],
			},
		),
	)

	// Register the command handlers
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.AddToChat, async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
			const context = await getContextForCommand(range, diagnostics)
			if (!context) {
				return
			}
			await addToDirac(context.controller, context.commandContext)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.FixWithDirac, async (range: vscode.Range, diagnostics: vscode.Diagnostic[]) => {
			const context = await getContextForCommand(range, diagnostics)
			if (!context) {
				return
			}
			await fixWithDirac(context.controller, context.commandContext)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.ExplainCode, async (range: vscode.Range) => {
			const context = await getContextForCommand(range)
			if (!context) {
				return
			}
			await explainWithDirac(context.controller, context.commandContext)
		}),
	)
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.ImproveCode, async (range: vscode.Range) => {
			const context = await getContextForCommand(range)
			if (!context) {
				return
			}
			await improveWithDirac(context.controller, context.commandContext)
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand(commands.FocusChatInput, async (preserveEditorFocus = false) => {
			// Prefer the instance the user is looking at; fall back to the sidebar.
			const instance = DiracWebviewProvider.getVisibleInstance() ?? DiracWebviewProvider.getSidebarInstance()

			if (!instance) {
				Logger.warn("Focus chat input: no webview instance available")
				return
			}

			// Show the webview. This must run even when the instance is already visible: only
			// `show(true)` moves OS focus into the view, and the in-page event below cannot.
			const webviewView = (instance as VscodeDiracWebviewProvider).getWebview?.()
			if (webviewView) {
				if (preserveEditorFocus) {
					// Only make webview visible without forcing focus
					webviewView.show(false)
				} else {
					// Show and force focus (default behavior for explicit focus actions)
					webviewView.show(true)
				}
			}

			instance.markActive()
			// Send show webview event with preserveEditorFocus flag
			await sendShowWebviewEvent(instance.controller.id, preserveEditorFocus)
			telemetryService.captureButtonClick("command_focusChatInput", instance.controller?.task?.ulid)
		}),
	)

	// Register Jupyter Notebook command handlers
	const NOTEBOOK_EDIT_INSTRUCTIONS = `Special considerations for using edit_file on *.ipynb files:
* Jupyter notebook files are JSON format with specific structure for source code cells
* Source code in cells is stored as JSON string arrays ending with explicit \\n characters and commas
* Always match the exact JSON format including quotes, commas, and escaped newlines.`

	// Helper to get notebook context for Jupyter commands
	async function getNotebookCommandContext(range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) {
		const activeNotebook = vscode.window.activeNotebookEditor
		if (!activeNotebook) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "No active Jupyter notebook found. Please open a .ipynb file first.",
			})
			return null
		}

		const ctx = await getContextForCommand(range, diagnostics)
		if (!ctx) {
			return null
		}

		const filePath = ctx.commandContext.filePath || ""
		let cellJson: string | null = null
		if (activeNotebook.notebook.cellCount > 0) {
			const cellIndex = activeNotebook.notebook.cellAt(activeNotebook.selection.start).index
			cellJson = await findMatchingNotebookCell(filePath, cellIndex)
		}

		return { ...ctx, cellJson }
	}

	context.subscriptions.push(
		vscode.commands.registerCommand(
			commands.JupyterGenerateCell,
			async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
				const userPrompt = await showJupyterPromptInput(
					"Generate Notebook Cell",
					"Enter your prompt for generating notebook cell (press Enter to confirm & Esc to cancel)",
				)
				if (!userPrompt) return

				const ctx = await getNotebookCommandContext(range, diagnostics)
				if (!ctx) return

				const notebookContext = `User prompt: ${userPrompt}
Insert a new Jupyter notebook cell above or below the current cell based on user prompt.
${NOTEBOOK_EDIT_INSTRUCTIONS}

Current Notebook Cell Context (JSON, sanitized of image data):
\`\`\`json
${ctx.cellJson || "{}"}
\`\`\``

				await addToDirac(ctx.controller, ctx.commandContext, notebookContext)
			},
		),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand(
			commands.JupyterExplainCell,
			async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
				const ctx = await getNotebookCommandContext(range, diagnostics)
				if (!ctx) return

				const notebookContext = ctx.cellJson
					? `\n\nCurrent Notebook Cell Context (JSON, sanitized of image data):\n\`\`\`json\n${ctx.cellJson}\n\`\`\``
					: undefined

				await explainWithDirac(ctx.controller, ctx.commandContext, notebookContext)
			},
		),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand(
			commands.JupyterImproveCell,
			async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
				const userPrompt = await showJupyterPromptInput(
					"Improve Notebook Cell",
					"Enter your prompt for improving the current notebook cell (press Enter to confirm & Esc to cancel)",
				)
				if (!userPrompt) return

				const ctx = await getNotebookCommandContext(range, diagnostics)
				if (!ctx) return

				const notebookContext = `User prompt: ${userPrompt}
${NOTEBOOK_EDIT_INSTRUCTIONS}

Current Notebook Cell Context (JSON, sanitized of image data):
\`\`\`json
${ctx.cellJson || "{}"}
\`\`\``

				await improveWithDirac(ctx.controller, ctx.commandContext, notebookContext)
			},
		),
	)

	// Register the openWalkthrough command handler
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.Walkthrough, async () => {
			await vscode.commands.executeCommand("workbench.action.openWalkthrough", `${context.extension.id}#DiracWalkthrough`)
			telemetryService.captureButtonClick("command_openWalkthrough")
		}),
	)

	// Register the reconstructTaskHistory command handler
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.ReconstructTaskHistory, async () => {
			const { reconstructTaskHistory } = await import("./core/commands/reconstructTaskHistory")
			await reconstructTaskHistory()
			telemetryService.captureButtonClick("command_reconstructTaskHistory")
		}),
	)

	// Register the generateGitCommitMessage command handler
	context.subscriptions.push(
		vscode.commands.registerCommand(commands.GenerateCommit, async (scm) => {
			generateCommitMsg(webview.controller, scm)
		}),
		vscode.commands.registerCommand(commands.AbortCommit, () => {
			abortCommitGeneration()
		}),
	)

	// --- Editor tab support: open conversations in tabs, detach/reattach background tasks ---

	const backgroundTaskStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
	backgroundTaskStatusBarItem.command = "dirac-ext.reattachBackgroundTask"
	context.subscriptions.push(backgroundTaskStatusBarItem)

	// Dirac EXT: a detached instance whose task has settled can never be re-attached to a surface,
	// so it must not be counted or offered as "running in the background".
	const getRunningBackgroundInstances = (): VscodeDiracWebviewProvider[] =>
		DiracWebviewProvider.getTabInstances()
			.map((instance) => instance as VscodeDiracWebviewProvider)
			.filter((instance) => instance.isDetached?.() && isTaskMidTurn(instance.controller.task))

	let backgroundTaskPollInterval: ReturnType<typeof setInterval> | undefined

	const updateBackgroundTaskStatus = () => {
		// Dirac EXT: reap settled detached instances first so their task claims are released and
		// the conversation can be reopened from history.
		for (const instance of [...DiracWebviewProvider.getTabInstances()]) {
			const tabInstance = instance as VscodeDiracWebviewProvider
			if (tabInstance.isDetached?.() && !isTaskMidTurn(tabInstance.controller.task)) {
				void tabInstance.dispose()
			}
		}

		// Dirac EXT: the background count is decided from state the user cannot see; record what it was
		// decided from, or a wrong count is undiagnosable after the fact. Debug level: this also runs on
		// the 5s poll while a task is detached.
		Logger.debug(
			`[Dirac EXT] background status: ${JSON.stringify(
				DiracWebviewProvider.getTabInstances().map((i) => {
					const t = (i as VscodeDiracWebviewProvider).controller.task
					return {
						detached: (i as VscodeDiracWebviewProvider).isDetached?.() ?? false,
						status: t?.taskState.status ?? "no task",
						apiActive: t?.taskState.isApiRequestActive ?? false,
					}
				}),
			)}`,
		)

		const runningCount = getRunningBackgroundInstances().length
		if (runningCount === 0) {
			backgroundTaskStatusBarItem.hide()
			if (backgroundTaskPollInterval) {
				clearInterval(backgroundTaskPollInterval)
				backgroundTaskPollInterval = undefined
			}
		} else {
			backgroundTaskStatusBarItem.text = `$(sync~spin) Dirac EXT: ${runningCount} running in background`
			backgroundTaskStatusBarItem.tooltip = "Click to re-attach a Dirac EXT task that is still running"
			backgroundTaskStatusBarItem.show()
			// Dirac EXT: poll so the status bar corrects itself when a detached task finishes
			// without requiring any user action.
			if (!backgroundTaskPollInterval) {
				backgroundTaskPollInterval = setInterval(() => updateBackgroundTaskStatus(), 5000)
			}
		}
	}

	// Dirac EXT: clear the poll interval on deactivation so it cannot leak.
	context.subscriptions.push({
		dispose: () => {
			if (backgroundTaskPollInterval) {
				clearInterval(backgroundTaskPollInterval)
				backgroundTaskPollInterval = undefined
			}
		},
	})

	/**
	 * True while the agent is mid-turn. A task that has finished sits at COMPLETED (or CANCELLED),
	 * not IDLE, so "status !== IDLE" would wrongly call every finished conversation busy.
	 */
	const isTaskMidTurn = (task?: { taskState: { isApiRequestActive?: boolean; status: TaskStatus } }): boolean => {
		if (!task) {
			return false
		}
		const settled: TaskStatus[] = [TaskStatus.IDLE, TaskStatus.COMPLETED, TaskStatus.CANCELLED]
		return task.taskState.isApiRequestActive === true || !settled.includes(task.taskState.status)
	}

	const openDiracTab = async (
		context: vscode.ExtensionContext,
		options?: { title?: string; provider?: VscodeDiracWebviewProvider; preserveTask?: boolean },
	): Promise<VscodeDiracWebviewProvider> => {
		const provider =
			options?.provider ?? (HostProvider.get().createDiracWebviewProvider("tab") as VscodeDiracWebviewProvider)
		const panel = vscode.window.createWebviewPanel(
			"dirac-ext.tab",
			options?.title ?? "Dirac EXT",
			vscode.ViewColumn.Active,
			{
				retainContextWhenHidden: true,
				enableScripts: true,
				localResourceRoots: [vscode.Uri.file(HostProvider.get().extensionFsPath)],
			},
		)
		panel.iconPath = vscode.Uri.joinPath(
			vscode.Uri.file(HostProvider.get().extensionFsPath),
			"assets",
			"icons",
			"icon-ext.svg",
		)
		// Closing a tab must never kill work in flight: detach while the agent is mid-turn, dispose
		// once it has settled (a finished conversation is not "running in the background").
		provider.setPanelCloseHandler((instance) => {
			const task = instance.controller.task
			const action = isTaskMidTurn(task) ? "detach" : "dispose"
			// Dirac EXT: closing a tab either keeps work alive or ends it, and the difference is
			// invisible afterwards — record which one happened and the state it was decided from.
			Logger.log(
				`[Dirac EXT] Tab closed -> ${action} (status=${task?.taskState.status ?? "no task"}, apiActive=${task?.taskState.isApiRequestActive ?? false})`,
			)
			return action
		})
		await provider.resolveSurface(panel, { preserveTask: options?.preserveTask })
		provider.markActive()
		panel.onDidDispose(() => updateBackgroundTaskStatus())
		return provider
	}

	openTasks.setConflictHandler(({ ownerControllerId }) => {
		const owner = DiracWebviewProvider.getInstanceByControllerId(ownerControllerId) as
			| VscodeDiracWebviewProvider
			| undefined
		// Dirac EXT: a detached owner has no panel, so reveal() would silently do nothing and leave
		// the user with no view to look at.
		if (owner?.isDetached?.()) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message:
					'That task is still running in the background. Use "Dirac EXT: Re-attach a Background Task" to bring it back.',
			})
			return
		}
		owner?.reveal()
		HostProvider.window.showMessage({
			type: ShowMessageType.INFORMATION,
			message: "That task is already open in another Dirac EXT view.",
		})
	})

	// Dirac EXT: the webview's "new tab" button reaches the host through the openInNewTab RPC, and the
	// core handler must not know about vscode — so supply the implementation here, the way the task
	// conflict handler above is supplied, and clear it on deactivation.
	setTabOpener(async () => {
		await openDiracTab(context)
		updateBackgroundTaskStatus()
	})
	context.subscriptions.push({ dispose: () => setTabOpener(undefined) })

	context.subscriptions.push(
		vscode.commands.registerCommand("dirac-ext.openInNewTab", async () => {
			await openDiracTab(context)
			updateBackgroundTaskStatus()
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("dirac-ext.openConversationInTab", async () => {
			const sidebar = DiracWebviewProvider.getSidebarInstance()
			if (!sidebar) {
				Logger.warn("Open conversation in tab: no sidebar instance available")
				return
			}
			const task = sidebar.controller.task
			if (!task) {
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message: "There is no conversation to move.",
				})
				return
			}
			if (isTaskMidTurn(task)) {
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message: "Task is running — open a new tab or wait",
				})
				return
			}
			const taskId = task.taskId
			// Dirac EXT: create the tab before releasing the claim so the task is never unclaimed
			// across the slow panel/surface setup, where a history click could steal it.
			const tab = await openDiracTab(context, { preserveTask: true })
			await sidebar.controller.clearTask()
			// Dirac EXT: clearTask() does not publish state (the "+" button pairs it with this call), so
			// without it the sidebar keeps rendering a conversation its controller no longer owns.
			await sidebar.controller.postStateToWebview()
			await tab.controller.reinitExistingTaskFromId(taskId)
			tab.markActive()
			updateBackgroundTaskStatus()
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("dirac-ext.reattachBackgroundTask", async () => {
			const detached = getRunningBackgroundInstances()
			if (detached.length === 0) {
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message: "No Dirac EXT tasks are running in the background.",
				})
				return
			}
			const items = detached.map((instance) => ({
				// Dirac EXT: the raw task id told the user nothing about which conversation this was;
				// the title derived from the conversation is recorded even while the tab is detached.
				label: instance.getTitle() ?? instance.controller.task?.taskId ?? "Untitled task",
				description: "running in the background",
				instance,
			}))
			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: "Select a background task to re-attach",
			})
			if (!picked) {
				return
			}
			await openDiracTab(context, {
				provider: picked.instance,
				preserveTask: true,
				title: picked.label,
			})
			updateBackgroundTaskStatus()
		}),
	)

	Logger.log(`[Dirac] extension activated in ${performance.now() - activationStartTime} ms`)

	return createDiracAPI(webview.controller)
}

async function showJupyterPromptInput(title: string, placeholder: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		const quickPick = vscode.window.createQuickPick()
		quickPick.title = title
		quickPick.placeholder = placeholder
		quickPick.ignoreFocusOut = true

		// Allow free text input
		quickPick.canSelectMany = false

		let userInput = ""

		quickPick.onDidChangeValue((value) => {
			userInput = value
			// Update items to show the current input
			if (value) {
				quickPick.items = [
					{
						label: "$(check) Use this prompt",
						detail: value,
						alwaysShow: true,
					},
				]
			} else {
				quickPick.items = []
			}
		})

		quickPick.onDidAccept(() => {
			if (userInput) {
				resolve(userInput)
				quickPick.hide()
			}
		})

		quickPick.onDidHide(() => {
			if (!userInput) {
				resolve(undefined)
			}
			quickPick.dispose()
		})

		quickPick.show()
	})
}

async function setupHostProvider(context: ExtensionContext, globalStorageFsPath: string) {
	const outputChannel = registerDiracOutputChannel(context)
	outputChannel.appendLine("[Dirac] Setting up VS Code host...")

	const ripgrep = await resolveWorkingRipgrepBinary(context.extensionUri.fsPath).catch((error: unknown) => {
		const resolutionError = toError(error)
		Logger.warn(`[Dirac] ${resolutionError.message}`)
		outputChannel.appendLine(`[Dirac] ${resolutionError.message}`)
		return resolutionError
	})

	if (!(ripgrep instanceof Error)) {
		outputChannel.appendLine(`[Dirac] Resolved rg from ${ripgrep.source}: ${ripgrep.path}`)
	}

	const getCachedBinaryLocation = async (name: string): Promise<string> => {
		if (!name.startsWith("rg")) {
			throw new Error(`Binary '${name}' is not supported`)
		}
		if (ripgrep instanceof Error) {
			throw ripgrep
		}
		return ripgrep.path
	}

	const createWebview = (surface: WebviewSurface = "sidebar") => new VscodeDiracWebviewProvider(context, surface)
	const createDiffView = () => new VscodeDiffViewProvider()
	const createCommentReview = () => getVscodeCommentReviewController()
	const createTerminalManager = () => new VscodeTerminalManager()
	const getEnvironmentVariables = async (cwd: string) => {
		const { getPythonEnvironmentVariables } = await import("@utils/python")
		return await getPythonEnvironmentVariables(vscode.Uri.file(cwd))
	}

	const getCallbackUrl = async (path: string, _preferredPort?: number) => {
		const scheme = vscode.env.uriScheme || "vscode"
		const callbackUri = vscode.Uri.parse(`${scheme}://${context.extension.id}${path}`)

		if (vscode.env.uiKind === vscode.UIKind.Web) {
			// In VS Code Web (Codespaces, code serve-web), vscode:// URIs redirect to the
			// desktop app instead of staying in the browser. Use asExternalUri to convert
			// to a web-reachable HTTPS URL that routes back to the extension's URI handler.
			const externalUri = await vscode.env.asExternalUri(callbackUri)
			return externalUri.toString(true)
		}

		// In regular desktop VS Code, use the vscode:// URI protocol handler directly.
		return callbackUri.toString(true)
	}
	HostProvider.initialize(
		"extension",
		createWebview,
		createDiffView,
		createCommentReview,
		createTerminalManager,
		vscodeHostBridgeClient,
		(msg: string) => outputChannel.appendLine(msg),
		getCallbackUrl,
		getCachedBinaryLocation,
		context.extensionUri.fsPath,
		globalStorageFsPath,

		getEnvironmentVariables,
	)
}

function getUriPath(url: string): string | undefined {
	try {
		return new URL(url).pathname
	} catch {
		return undefined
	}
}

async function openDiracSidebarForTaskUri(): Promise<void> {
	const sidebarWaitTimeoutMs = 3000
	const sidebarWaitIntervalMs = 50

	await vscode.commands.executeCommand(`${ExtensionRegistryInfo.views.Sidebar}.focus`)

	const startedAt = Date.now()
	while (Date.now() - startedAt < sidebarWaitTimeoutMs) {
		if (DiracWebviewProvider.getVisibleInstance()) {
			return
		}
		await new Promise((resolve) => setTimeout(resolve, sidebarWaitIntervalMs))
	}

	Logger.warn("Task URI handling timed out waiting for Dirac sidebar visibility")
}

// This method is called when your extension is deactivated
export async function deactivate() {
	// Dispose Non-VSCode-specific services
	await tearDown()

	// VSCode-specific services
	disposeVscodeCommentReviewController()
}

// TODO: Find a solution for automatically removing DEV related content from production builds.
//  This type of code is fine in production to keep. We just will want to remove it from production builds
//  to bring down built asset sizes.
//
// This is a workaround to reload the extension when the source code changes
// since vscode doesn't support hot reload for extensions
const IS_DEV = isDev()
const DEV_WORKSPACE_FOLDER = process.env.DEV_WORKSPACE_FOLDER

// Set up development mode file watcher
if (IS_DEV) {
	assert(DEV_WORKSPACE_FOLDER, "DEV_WORKSPACE_FOLDER must be set in development")
	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(DEV_WORKSPACE_FOLDER, "src/**/*"))

	watcher.onDidChange(({ scheme, path }) => {
		Logger.info(`${scheme} ${path} changed. Reloading VSCode...`)

		vscode.commands.executeCommand("workbench.action.reloadWindow")
	})
}

// VSCode-specific storage migrations
async function cleanupLegacyVSCodeStorage(context: ExtensionContext): Promise<void> {
	try {
		await cleanupOldApiKey(context)
		// Migrate is not done if the new storage does not have the lastShownAnnouncementId flag
		const hasMigrated = context.globalState.get("lastShownAnnouncementId")
		if (hasMigrated !== undefined) {
			return
		}

		Logger.info("[VS Code Storage Migrations] Starting")

		// Migrate custom instructions to global Dirac rules (one-time cleanup)
		await migrateCustomInstructionsToGlobalRules(context)

		// Migrate welcomeViewCompleted setting based on existing API keys (one-time cleanup)
		await migrateWelcomeViewCompleted(context)

		// Migrate workspace storage values back to global storage (reverting previous migration)
		await migrateWorkspaceToGlobalStorage(context)

		// Ensure taskHistory.json exists and migrate legacy state (runs once)
		await migrateTaskHistoryToFile(context)

		// lastShownAnnouncementId will be set when announcement is shown
		// after activation so we don't need to set it here.

		Logger.info("[VS Code Storage Migrations] Completed")
	} catch (error) {
		const errorMessage = getErrorMessage(error, "")
		Logger.warn(`[VS Code Storage Migrations] Failed${errorMessage ? `: ${errorMessage}` : ""}`)
	}
}
