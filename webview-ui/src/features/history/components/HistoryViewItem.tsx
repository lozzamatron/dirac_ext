import { isGoalHistoryItem, type HistoryItem } from "@shared/HistoryItem"
import { StringRequest } from "@shared/proto/dirac/common"
import { GoalControlRequest } from "@shared/proto/dirac/goal"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import {
	ArrowDownIcon,
	ArrowLeftIcon,
	ArrowRightIcon,
	ArrowUpIcon,
	ChevronsDownUpIcon,
	ChevronsUpDownIcon,
	DownloadIcon,
	StarIcon,
	TrashIcon,
} from "lucide-react"
import { memo, useCallback, useMemo, useState } from "react"
import { useAppStore } from "@/app/store/appStore"
import { cn } from "@/lib/utils"
import { GoalServiceClient, TaskServiceClient } from "@/shared/api/grpc-client"
import { formatLargeNumber, formatSize } from "@/shared/lib/format"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"

type HistoryViewItemProps = {
	item: HistoryItem
	isSelected: boolean
	isDeleting: boolean
	actionsDisabled: boolean
	pendingFavoriteToggles: Record<string, boolean>
	handleDeleteHistoryItem: (id: string) => void
	toggleFavorite: (id: string, isCurrentlyFavorited: boolean) => void
	handleHistorySelect: (itemId: string, checked: boolean) => void
}

const HistoryViewItem = ({
	item,
	pendingFavoriteToggles,
	handleDeleteHistoryItem,
	toggleFavorite,
	handleHistorySelect,
	isSelected,
	isDeleting,
	actionsDisabled,
}: HistoryViewItemProps) => {
	const navigateToChat = useAppStore((state) => state.navigateToChat)
	const [expanded, setExpanded] = useState(false)
	const [isOpening, setIsOpening] = useState(false)
	const [openError, setOpenError] = useState<string>()
	const detailsId = `history-details-${item.id}`
	const isGoal = isGoalHistoryItem(item)
	const displayText = isGoal ? item.objectivePreview : item.task
	const displayCost = isGoal ? item.accounting.cost : item.totalCost
	const inputTokens = isGoal ? item.accounting.inputTokens : item.tokensIn
	const outputTokens = isGoal ? item.accounting.outputTokens : item.tokensOut
	const cacheWrites = isGoal ? item.accounting.cacheWriteTokens : item.cacheWrites
	const cacheReads = isGoal ? item.accounting.cacheReadTokens : item.cacheReads

	const isFavoritedItem = useMemo(
		() => pendingFavoriteToggles[item.id] ?? item.isFavorited,
		[item.id, item.isFavorited, pendingFavoriteToggles],
	)

	const showRun = useCallback(async () => {
		setIsOpening(true)
		setOpenError(undefined)
		try {
			if (isGoal) {
				await GoalServiceClient.selectGoal(GoalControlRequest.create({ goalId: item.id }))
			} else {
				await TaskServiceClient.showTaskWithId(StringRequest.create({ value: item.id }))
			}
			navigateToChat()
		} catch (error) {
			console.error("Error showing history run:", error)
			setOpenError(
				error instanceof Error
					? error.message
					: `This ${isGoal ? "Goal" : "task"} could not be opened. Its saved history may be unavailable or unreadable.`,
			)
		} finally {
			setIsOpening(false)
		}
	}, [isGoal, item.id, navigateToChat])

	const formatDate = useCallback((timestamp: number) => {
		const date = new Date(timestamp)
		const today = new Date()
		const options: Intl.DateTimeFormatOptions =
			today.toDateString() === date.toDateString()
				? { hour: "numeric", minute: "2-digit", hour12: true }
				: { month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }
		return date.toLocaleString("en-US", options).replace(", ", " ").replace(" at", ",")
	}, [])

	return (
		<article
			aria-busy={isDeleting || isOpening}
			className={cn(
				"history-item group mb-1 flex border-b border-accent/10 hover:bg-list-hover",
				isDeleting && "opacity-50",
			)}>
			<VSCodeCheckbox
				aria-label={`Select ${isGoal ? "Goal" : "task"}: ${displayText}`}
				checked={isSelected}
				className="mt-3 self-start py-auto pl-3 pr-1"
				disabled={actionsDisabled}
				onChange={(event) => handleHistorySelect(item.id, (event.target as HTMLInputElement).checked)}
			/>

			<div className="relative flex min-w-0 flex-grow flex-col gap-2 py-2 pl-2 pr-3">
				<div className="flex items-center gap-2">
					<button
						className="min-w-0 flex-1 cursor-pointer overflow-hidden border-0 bg-transparent p-0 text-left focus-visible:outline-1 focus-visible:outline-ring"
						disabled={actionsDisabled || isOpening}
						onClick={showRun}
						title={`Open ${isGoal ? "Goal" : "task"}`}
						type="button">
						<span className="flex min-w-0 items-center gap-2">
							{isGoal && <Badge className="shrink-0">Goal</Badge>}
							<span className="ph-no-capture line-clamp-1 break-words whitespace-pre-wrap">{displayText}</span>
						</span>
					</button>
					<div className="flex flex-shrink-0 gap-2">
						<Button
							aria-label={`Delete ${isGoal ? "Goal" : "task"}`}
							className="p-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
							disabled={isFavoritedItem || actionsDisabled}
							onClick={() => handleDeleteHistoryItem(item.id)}
							title={
								isFavoritedItem
									? `Remove this ${isGoal ? "Goal" : "task"} from favorites before deleting it`
									: `Delete ${isGoal ? "Goal" : "task"}`
							}
							variant="ghost">
							<TrashIcon className="stroke-1" />
						</Button>
						<Button
							aria-label={isFavoritedItem ? "Remove from favorites" : "Add to favorites"}
							className="p-0"
							disabled={pendingFavoriteToggles[item.id] !== undefined || actionsDisabled}
							onClick={() => toggleFavorite(item.id, Boolean(isFavoritedItem))}
							variant="icon">
							<StarIcon
								className={cn("opacity-70", {
									"fill-button-background text-button-background opacity-100": isFavoritedItem,
								})}
							/>
						</Button>
					</div>
				</div>

				{openError && (
					<div className="rounded-xs bg-error/10 px-2 py-1 text-xs text-error" role="alert">
						{openError}
					</div>
				)}

				<Button
					aria-controls={detailsId}
					aria-expanded={expanded}
					aria-label={
						expanded ? `Hide ${isGoal ? "Goal" : "task"} details` : `Show ${isGoal ? "Goal" : "task"} details`
					}
					className="w-full p-0"
					onClick={() => setExpanded((current) => !current)}
					variant="icon">
					<span className="flex w-full items-center justify-between">
						<span className="text-xs uppercase text-description">{formatDate(item.ts)}</span>
						<span className="flex items-center text-xs">
							<span className="text-description">
								{displayCost === undefined ? "—" : `$${displayCost.toFixed(4)}`}
							</span>
							{expanded ? (
								<ChevronsDownUpIcon className="text-description" />
							) : (
								<ChevronsUpDownIcon className="text-description opacity-60 group-hover:opacity-100" />
							)}
						</span>
					</span>
				</Button>

				{expanded && (
					<div className="m-0 w-full rounded-xs bg-accent/10 p-2 text-xs" id={detailsId}>
						<div className="flex w-full flex-col gap-1 text-xs">
							{isGoal && (
								<>
									<div className="flex w-full items-start justify-between gap-2">
										<span className="font-medium text-description">Status:</span>
										<span className="text-right capitalize text-description">{item.status}</span>
									</div>
									<div className="flex w-full items-start justify-between gap-2">
										<span className="font-medium text-description">Revision:</span>
										<span className="text-right text-description">{item.objectiveRevision}</span>
									</div>
								</>
							)}
							<div className="flex w-full items-center justify-between gap-1">
								<span className="font-medium text-description">Tokens:</span>
								<span className="flex items-center gap-1 text-xs text-description">
									<span className="flex items-center gap-1">
										<ArrowUpIcon className="!size-1" />
										{inputTokens === undefined ? "—" : formatLargeNumber(inputTokens)}
									</span>
									<span className="flex items-center gap-1">
										<ArrowDownIcon className="!size-1" />
										{outputTokens === undefined ? "—" : formatLargeNumber(outputTokens)}
									</span>
									{cacheWrites !== undefined && (
										<span className="flex items-center gap-1">
											<ArrowRightIcon className="!size-1" />
											{formatLargeNumber(cacheWrites)}
										</span>
									)}
									{cacheReads !== undefined && (
										<span className="flex items-center gap-1">
											<ArrowLeftIcon className="!size-1" />
											{formatLargeNumber(cacheReads)}
										</span>
									)}
								</span>
							</div>

							{item.modelId && (
								<div className="flex w-full items-start justify-between gap-2">
									<span className="font-medium text-description">Model:</span>
									<span className="break-all text-right text-description">{item.modelId}</span>
								</div>
							)}

							{!isGoal && <div className="flex w-full items-center justify-between gap-1">
								<span className="font-medium text-description">Size:</span>
								<span className="flex items-center gap-2 text-description">
									{formatSize(item.size)}
									<Button
										aria-label="Export task"
										className="m-0 p-0"
										onClick={() =>
											TaskServiceClient.exportTaskWithId(
												StringRequest.create({ value: item.id }),
											).catch((error) => console.error("Failed to export task:", error))
										}
										variant="ghost">
										<DownloadIcon />
									</Button>
								</span>
							</div>}
						</div>
					</div>
				)}
			</div>
		</article>
	)
}

export default memo(HistoryViewItem)
