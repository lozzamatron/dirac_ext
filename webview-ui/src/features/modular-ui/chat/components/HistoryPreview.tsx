import { StringRequest } from "@shared/proto/dirac/common"
import { GoalControlRequest } from "@shared/proto/dirac/goal"
import { isGoalHistoryItem, type HistoryItem } from "@shared/HistoryItem"
import { memo, useMemo, useState } from "react"
import DiracLogoVariable from "@/assets/DiracLogoVariable"
import { useTaskStore } from "@/entities/task/store/taskStore"
import { GoalServiceClient, TaskServiceClient } from "@/shared/api/grpc-client"
import { getRandomQuote } from "@shared/quotes"

type HistoryPreviewProps = {
	showHistoryView: () => void
}

const HistoryPreview = ({ showHistoryView }: HistoryPreviewProps) => {
	const taskHistory = useTaskStore((state) => state.taskHistory)
	const [openError, setOpenError] = useState<string>()
	const quote = useMemo(() => getRandomQuote(), [])
	const recentRuns = taskHistory.filter((item) => item.ts && item.task)
	const handleHistorySelect = (item: HistoryItem) => {
		setOpenError(undefined)
		const openRun = isGoalHistoryItem(item)
			? GoalServiceClient.selectGoal(GoalControlRequest.create({ goalId: item.id }))
			: TaskServiceClient.showTaskWithId(StringRequest.create({ value: item.id }))
		openRun.catch((error) => {
			console.error("Error showing history run:", error)
			setOpenError(error instanceof Error ? error.message : "This run could not be opened.")
		})
	}

	const formatDate = (timestamp: number) => {
		const date = new Date(timestamp)
		return date?.toLocaleString("en-US", {
			month: "short",
			day: "numeric",
		})
	}

	return (
		<div style={{ flexShrink: 0 }}>
			<style>
				{`
					.history-preview-item {
						background-color: var(--dirac-surface-raised);
						border-radius: 4px;
						position: relative;
						overflow: hidden;
						cursor: pointer;
						margin-bottom: 8px;
						padding: 10px 12px;
						display: flex;
						align-items: flex-start;
						gap: 12px;
					}
					.history-preview-item:hover {
						background-color: var(--dirac-surface-hover);
						pointer-events: auto;
					}
					.history-task-content {
						flex: 1;
						display: flex;
						align-items: flex-start;
						gap: 8px;
						min-width: 0;
					}
					.history-task-description {
						flex: 1;
						overflow: hidden;
						display: -webkit-box;
						-webkit-line-clamp: 2;
						-webkit-box-orient: vertical;
						color: var(--vscode-foreground);
						font-size: var(--vscode-font-size);
						line-height: 1.4;
					}
					.history-meta-stack {
						display: flex;
						flex-direction: column;
						align-items: center;
						gap: 4px;
						flex-shrink: 0;
					}
					.history-date {
						color: var(--vscode-descriptionForeground);
						font-size: 0.85em;
						white-space: nowrap;
					}
					.history-cost-chip {
						background-color: color-mix(in srgb, var(--vscode-badge-background) 42%, transparent);
						border: 1px solid color-mix(in srgb, var(--vscode-badge-foreground) 22%, transparent);
						color: var(--vscode-foreground);
						padding: 2px 8px;
						border-radius: 12px;
						font-size: 0.85em;
						font-weight: 600;
						white-space: nowrap;
					}
					.history-view-all-btn {
						background: none;
						border: none;
						padding: 4px 0 4px 8px;
						cursor: pointer;
						font-size: 0.85em;
						font-weight: 500;
						color: var(--vscode-descriptionForeground);
						white-space: nowrap;
						display: flex;
						align-items: center;
						gap: 2px;
					.history-view-all-btn .codicon {
						font-size: 1.2em;
					}
					.history-view-all-btn:hover {
						color: var(--vscode-foreground);
					}
				`}
			</style>

			<div
				className="history-header"
				style={{
					color: "var(--vscode-descriptionForeground)",
					margin: "10px 16px 10px 16px",
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
				}}>
				<div style={{ display: "flex", alignItems: "center" }}>
					<span
						className="codicon codicon-comment-discussion"
						style={{
							marginRight: "4px",
							transform: "scale(0.9)",
						}}
					/>
					<span
						style={{
							fontWeight: 500,
							fontSize: "0.85em",
							textTransform: "uppercase",
						}}>
						Recent
					</span>
				</div>
				{recentRuns.length > 0 && (
					<button
						aria-label="View all history"
						className="history-view-all-btn"
						onClick={() => showHistoryView()}
						type="button">
						View All
						<span className="codicon codicon-chevron-right" />
					</button>
				)}
			</div>
			<div className="px-4">
				<div className="flex justify-center py-3 pb-5">
					<div className="flex flex-col items-center gap-2">
						<div className="dirac-logo-aura">
							<DiracLogoVariable transparentBackground />
						</div>
						<div className="text-[0.9em] text-(--vscode-descriptionForeground) italic text-center max-w-[80%] leading-[1.4]">
							"{quote}"
						</div>
					</div>
				</div>
			</div>

			{openError && (
				<div className="mx-4 mb-2 rounded-xs bg-error/10 px-2 py-1 text-xs text-error" role="alert">
					{openError}
				</div>
			)}

			{
				<div className="px-4">
					{recentRuns.length > 0 ? (
						recentRuns.slice(0, 3).map((item) => (
							<div className="history-preview-item" key={item.id} onClick={() => handleHistorySelect(item)}>
								<div className="history-task-content">
									{item.isFavorited && (
										<span
											aria-label="Favorited"
											className="codicon codicon-star-full"
											style={{
												color: "var(--vscode-button-background)",
												flexShrink: 0,
											}}
										/>
									)}
									<div className="history-task-description ph-no-capture">
										{isGoalHistoryItem(item) && (
											<span className="mr-1 rounded bg-(--vscode-badge-background) px-1.5 py-0.5 text-[10px] font-medium text-(--vscode-badge-foreground)">
												Goal
											</span>
										)}
										{isGoalHistoryItem(item) ? item.objectivePreview : item.task}
									</div>
								</div>
								<div className="history-meta-stack">
									<span className="history-date">{formatDate(item.ts)}</span>
									<span className="history-cost-chip">
										{isGoalHistoryItem(item)
											? item.accounting.cost === undefined
												? "—"
												: `$${item.accounting.cost.toFixed(2)}`
											: `$${item.totalCost.toFixed(2)}`}
									</span>
								</div>
							</div>
						))
					) : (
						<div
							style={{
								textAlign: "center",
								color: "var(--vscode-descriptionForeground)",
								fontSize: "var(--vscode-font-size)",
								padding: "10px 0",
							}}>
							No recent runs
						</div>
					)}
				</div>
			}
		</div>
	)
}

export default memo(HistoryPreview)
