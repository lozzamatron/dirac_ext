import { type GoalHistoryItem, isGoalHistoryItem } from "@shared/HistoryItem"
import { StringRequest } from "@shared/proto/dirac/common"
import { TaskResponse } from "@shared/proto/dirac/task"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."
import { sendChatButtonClickedEvent } from "../ui/subscribeToChatButtonClicked"

export function goalHistoryItemToTaskResponse(historyItem: GoalHistoryItem): TaskResponse {
	return TaskResponse.create({
		id: historyItem.id,
		task: historyItem.initialDisplayText,
		ts: historyItem.ts,
		isFavorited: historyItem.isFavorited ?? false,
		size: historyItem.size ?? 0,
		runKind: "goal",
		accounting: historyItem.accounting,
	})
}

/**
 * Shows a task with the specified ID
 * @param controller The controller instance
 * @param request The request containing the task ID
 * @returns TaskResponse with task details
 */
export async function showTaskWithId(controller: Controller, request: StringRequest): Promise<TaskResponse> {
	try {
		const id = request.value

		// First check if task exists in global state for faster access
		const taskHistory = controller.stateManager.getGlobalStateKey("taskHistory")
		const historyItem = taskHistory.find((item) => item.id === id)
		if (historyItem && isGoalHistoryItem(historyItem)) {
			await controller.selectGoal(id)
			await sendChatButtonClickedEvent(controller.id)
			return goalHistoryItemToTaskResponse(historyItem)
		}

		// We need to initialize the task before returning data
		if (historyItem) {
			// Always initialize the task with the history item
			await controller.initTask(undefined, undefined, undefined, historyItem)

			// Send UI update to show the chat view
			await sendChatButtonClickedEvent(controller.id)

			// Return task data for gRPC response
			return TaskResponse.create({
				id: historyItem.id,
				task: historyItem.task || "",
				ts: historyItem.ts || 0,
				isFavorited: historyItem.isFavorited || false,
				size: historyItem.size || 0,
				totalCost: historyItem.totalCost || 0,
				tokensIn: historyItem.tokensIn || 0,
				tokensOut: historyItem.tokensOut || 0,
				cacheWrites: historyItem.cacheWrites || 0,
				cacheReads: historyItem.cacheReads || 0,
			})
		}

		// If not in global state, fetch from storage
		const { historyItem: fetchedItem } = await controller.getTaskWithId(id)
		if (isGoalHistoryItem(fetchedItem)) throw new Error(`Run ${id} was loaded as a Goal through Task storage`)

		// Initialize the task with the fetched item
		await controller.initTask(undefined, undefined, undefined, fetchedItem)

		// Send UI update to show the chat view
		await sendChatButtonClickedEvent(controller.id)

		return TaskResponse.create({
			id: fetchedItem.id,
			task: fetchedItem.task || "",
			ts: fetchedItem.ts || 0,
			isFavorited: fetchedItem.isFavorited || false,
			size: fetchedItem.size || 0,
			totalCost: fetchedItem.totalCost || 0,
			tokensIn: fetchedItem.tokensIn || 0,
			tokensOut: fetchedItem.tokensOut || 0,
			cacheWrites: fetchedItem.cacheWrites || 0,
			cacheReads: fetchedItem.cacheReads || 0,
		})
	} catch (error) {
		Logger.error("Error in showTaskWithId:", error)
		throw error
	}
}
