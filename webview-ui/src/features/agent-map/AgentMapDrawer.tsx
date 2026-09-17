// Detail drawer for a single Agent Map node: prompt, trajectory, usage and
// transcript reference for one subagent run or Goal child task. Purely
// presentational — the map overlay owns the data and the clock (`now`), so this
// component stays free of store access and time reads and renders whatever
// snapshot it is handed.
import React from "react"
import { XIcon } from "lucide-react"

import { Button } from "@/shared/ui/button"

import {
	AgentMapNode,
	agentMapNodeDurationMs,
	agentMapTotalTokens,
	formatAgentMapDuration,
	formatAgentMapTokens,
} from "@shared/agentMap"
import { SubagentTrajectoryEventType } from "@shared/subagents"

// Exhaustive on purpose: adding a member to SubagentTrajectoryEventType must
// break the build here rather than silently render a blank label in the drawer.
export const AGENT_MAP_TRAJECTORY_LABELS: Record<SubagentTrajectoryEventType, string> = {
	[SubagentTrajectoryEventType.MESSAGE]: "Says",
	[SubagentTrajectoryEventType.TOOL]: "Tool",
	[SubagentTrajectoryEventType.TOOL_RESULT]: "Result",
	[SubagentTrajectoryEventType.RESULT]: "Done",
	[SubagentTrajectoryEventType.ERROR]: "Error",
}

const SECTION_HEADING_CLASS =
	"text-xs font-medium uppercase tracking-wide text-[var(--vscode-descriptionForeground)] mt-3"

export const AgentMapDrawer: React.FC<{
	node: AgentMapNode
	now: number
	onClose: () => void
}> = ({ node, now, onClose }) => {
	const durationMs = agentMapNodeDurationMs(node, now)
	const quietFacts = [
		node.status,
		durationMs === undefined ? undefined : formatAgentMapDuration(durationMs),
		node.modelId,
	].filter((fact): fact is string => fact !== undefined && fact !== "")

	const usage = node.usage
	const totalTokens = agentMapTotalTokens(usage)
	const prompt = typeof node.prompt === "string" && node.prompt.length > 0 ? node.prompt : undefined
	const trajectory = node.trajectory && node.trajectory.length > 0 ? node.trajectory : undefined

	return (
		<div
			data-testid="agent-map-drawer"
			role="group"
			aria-label="Agent details"
			className="mt-4 rounded-md border border-[var(--vscode-panel-border)] bg-[var(--vscode-editorWidget-background)] p-4"
		>
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<h2 className="text-sm font-semibold">{node.title}</h2>
					{quietFacts.length > 0 && (
						<p className="text-xs text-[var(--vscode-descriptionForeground)]">{quietFacts.join(" · ")}</p>
					)}
				</div>
				<Button
					variant="icon"
					size="icon"
					aria-label="Close agent details"
					data-testid="agent-map-drawer-close"
					onClick={onClose}
				>
					<XIcon size={14} />
				</Button>
			</div>

			{prompt && (
				<section>
					<h3 className={SECTION_HEADING_CLASS}>Prompt</h3>
					<p className="mt-1 whitespace-pre-wrap break-words text-sm">{prompt}</p>
				</section>
			)}

			{trajectory && (
				<section>
					<h3 className={SECTION_HEADING_CLASS}>Trajectory</h3>
					<ol className="mt-1 space-y-1">
						{trajectory.map((event, index) => (
							<li key={index} className="flex gap-2">
								<span className="shrink-0 text-[10px] uppercase text-[var(--vscode-descriptionForeground)]">
									{AGENT_MAP_TRAJECTORY_LABELS[event.type]}
								</span>
								<span
									className={`whitespace-pre-wrap break-words text-sm ${
										event.type === SubagentTrajectoryEventType.ERROR
											? "text-[var(--vscode-errorForeground)]"
											: ""
									}`}
								>
									{event.text}
								</span>
							</li>
						))}
					</ol>
				</section>
			)}

			{usage && totalTokens > 0 && (
				<section>
					<h3 className={SECTION_HEADING_CLASS}>Usage</h3>
					<dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
						<UsageRow label="Input" value={formatAgentMapTokens(usage.inputTokens)} show={usage.inputTokens > 0} />
						<UsageRow label="Output" value={formatAgentMapTokens(usage.outputTokens)} show={usage.outputTokens > 0} />
						<UsageRow
							label="Cache read"
							value={formatAgentMapTokens(usage.cacheReadTokens)}
							show={usage.cacheReadTokens > 0}
						/>
						<UsageRow
							label="Cache write"
							value={formatAgentMapTokens(usage.cacheWriteTokens)}
							show={usage.cacheWriteTokens > 0}
						/>
						<UsageRow label="Total" value={formatAgentMapTokens(totalTokens)} show />
						<UsageRow
							label="Cost"
							value={`$${(usage.totalCost ?? 0).toFixed(4)}`}
							show={typeof usage.totalCost === "number" && usage.totalCost > 0}
						/>
					</dl>
				</section>
			)}

			{node.transcriptRef && (
				// Plain text on purpose: nothing in the webview can open a task
				// directory yet, and a link-shaped affordance that does nothing is
				// worse than selectable text. WP5 gives this a real action.
				<p
					data-testid="agent-map-transcript-ref"
					className="mt-3 select-all text-xs text-[var(--vscode-descriptionForeground)]"
				>
					{`Transcript: ${node.transcriptRef.taskId}`}
				</p>
			)}
		</div>
	)
}

const UsageRow: React.FC<{ label: string; value: string; show: boolean }> = ({ label, value, show }) => {
	if (!show) {
		return null
	}
	return (
		<div className="flex items-baseline justify-between gap-2">
			<dt className="text-[var(--vscode-descriptionForeground)]">{label}</dt>
			<dd className="text-[var(--vscode-foreground)] tabular-nums">{value}</dd>
		</div>
	)
}
