import { executeHook } from "@core/hooks/hook-executor"
import { getTaskHookModelContext } from "../runtime/TaskRuntimeModelContext"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { Logger } from "@shared/services/Logger"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import type { LifecycleManagerDependencies } from "../types/lifecycle-manager"

// Manages task abort/cancel — sets abort flag, cancels hooks/commands, runs TaskCancel hook, cleans up resources.
export class TaskAbortManager {
	constructor(private deps: LifecycleManagerDependencies) {}

	async abort(): Promise<void> {
		try {
			const shouldRunCancelHook = await this.deps.hookManager.shouldRunTaskCancelHook()
			this.deps.taskState.abort = true
			await this.cancelActiveHook()
			await this.cancelBackgroundCommand()
			await this.runTaskCancelHook(shouldRunCancelHook)
			await this.saveStateAndPost()
			await this.disposeResources()
		} finally {
			await this.postFinalState()
		}
	}

	private async cancelActiveHook() {
		const activeHook = await this.deps.hookManager.getActiveHookExecution()
		if (!activeHook) return
		try {
			await this.deps.hookManager.cancelHookExecution()
			await this.deps.hookManager.clearActiveHookExecution()
		} catch (error) {
			Logger.error("Failed to cancel hook during task abort", error)
			await this.deps.hookManager.clearActiveHookExecution()
		}
	}

	private async cancelBackgroundCommand() {
		if (!this.deps.commandExecutor.hasActiveBackgroundCommand()) return
		try {
			await this.deps.commandExecutor.cancelBackgroundCommand()
		} catch (error) {
			Logger.error("Failed to cancel background command during task abort", error)
		}
	}

	private async runTaskCancelHook(shouldRun: boolean) {
		const hooksEnabled = getHooksEnabledSafe(this.deps.getWorkingConfiguration().settings.hooksEnabled)
		if (!hooksEnabled || !shouldRun) return
		try {
			await executeHook({
				hookName: "TaskCancel",
				hookInput: {
					taskCancel: {
						taskMetadata: {
							taskId: this.deps.taskId,
							ulid: this.deps.ulid,
							completionStatus: this.deps.taskState.abandoned ? "abandoned" : "cancelled",
						},
					},
				},
				isCancellable: false,
				messenger: this.deps.taskMessenger,
				messageStateHandler: this.deps.messageStateHandler,
				taskId: this.deps.taskId,
				hooksEnabled,
				model: getTaskHookModelContext(this.deps.api, this.deps.getWorkingConfiguration()),
			})
		} catch (error) {
			Logger.error("[TaskCancel Hook] Failed (non-fatal):", error)
		}
	}

	private async saveStateAndPost() {
		try {
			await this.deps.messageStateHandler.saveDiracMessagesAndUpdateHistory()
			await this.deps.postStateToWebview()
		} catch (error) {
			Logger.error("Failed to post state after setting abort flag", error)
		}
	}

	private async disposeResources(): Promise<void> {
		this.deps.terminalManager.disposeAll()
		this.deps.urlContentFetcher.closeBrowser()
		this.deps.browserSession.dispose()
		this.deps.diracIgnoreController.dispose()
		this.deps.fileContextTracker.dispose()
		await this.deps.diffViewProvider.revertChanges()
		AnchorStateManager.reset(this.deps.ulid)
	}


	private async postFinalState() {
		try {
			await this.deps.postStateToWebview()
		} catch (error) {
			Logger.error("Failed to post final state after abort", error)
		}
	}
}
