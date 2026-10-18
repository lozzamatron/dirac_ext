import { withTaskHistoryInventoryLock } from "@core/storage/taskHistory"
import { DeleteAllTaskHistoryCount } from "@shared/proto/dirac/task"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageRequest, ShowMessageType } from "@/shared/proto/host/window"
import { Controller } from ".."
import { deleteRunsStorage } from "../TaskHistoryController"

/** Deletes only the selected history inventory, under each run's execution lock. */
export async function deleteAllTaskHistory(controller: Controller): Promise<DeleteAllTaskHistoryCount> {
	const initialTaskHistory = controller.stateManager.getGlobalStateKey("taskHistory")
	const userChoice = (
		await HostProvider.window.showMessage(
			ShowMessageRequest.create({
				type: ShowMessageType.WARNING,
				message: "What would you like to delete?",
				options: { modal: true, items: ["Delete All Except Favorites", "Delete Everything"] },
			}),
		)
	).selectedOption
	if (userChoice === undefined) return DeleteAllTaskHistoryCount.create({ tasksDeleted: 0 })
	const preserveFavorites = userChoice === "Delete All Except Favorites"
	const initiallyHadFavorites = initialTaskHistory.some((task) => task.isFavorited === true)
	if (preserveFavorites && !initialTaskHistory.some((task) => task.isFavorited === true) && !(await confirmDeleteAllTasks())) {
		return DeleteAllTaskHistoryCount.create({ tasksDeleted: 0 })
	}
	return withTaskHistoryInventoryLock(async () => {
		await controller.clearTask()
		const history = controller.stateManager.getGlobalStateKey("taskHistory")
		if (
			preserveFavorites &&
			initiallyHadFavorites &&
			!history.some((item) => item.isFavorited) &&
			!(await confirmDeleteAllTasks())
		) {
			await controller.postStateToWebview()
			return DeleteAllTaskHistoryCount.create({ tasksDeleted: 0 })
		}
		const items = history.filter((item) => !preserveFavorites || !item.isFavorited)
		await deleteRunsStorage(items)
		await controller.stateManager.removeTaskHistoryItems(items.map((item) => item.id))
		await controller.stateManager.flushPendingState()
		await controller.postStateToWebview()
		return DeleteAllTaskHistoryCount.create({ tasksDeleted: items.length })
	})
}

async function confirmDeleteAllTasks(): Promise<boolean> {
	const answer = (
		await HostProvider.window.showMessage({
			type: ShowMessageType.WARNING,
			message: "No favorited tasks found. Would you like to delete all tasks anyway?",
			options: {
				modal: true,
				items: ["Delete All Tasks"],
			},
		})
	).selectedOption

	return answer === "Delete All Tasks"
}
