// One node of the Agent Map as a clickable card: a real <button> so keyboard
// users reach it by tab order and Enter works natively. The status is carried
// in the title attribute (and the dot colour) so state never relies on colour
// alone, per the reference design's dot-only treatment.
import type React from "react"
import type { AgentMapNode, AgentMapNodeStatus } from "@shared/agentMap"
import {
	agentMapNodeDurationMs,
	agentMapTotalTokens,
	formatAgentMapDuration,
	formatAgentMapTokens,
} from "@shared/agentMap"
import { cn } from "@/lib/utils"

// Maps a node status to a VS Code chart/semantic colour variable. Exported so
// the drawer (and any future surface) shows the same colour for the same status.
export function agentMapStatusColor(status: AgentMapNodeStatus): string {
	switch (status) {
		case "running":
			return "var(--vscode-charts-orange)"
		case "waiting":
		case "pending":
			return "var(--vscode-charts-yellow)"
		case "completed":
			return "var(--vscode-descriptionForeground)"
		case "failed":
			return "var(--vscode-errorForeground)"
		case "cancelled":
			return "var(--vscode-disabledForeground)"
	}
}

export const AgentMapNodeCard: React.FC<{
	node: AgentMapNode
	now: number
	isRoot?: boolean
	isSelected?: boolean
	onSelect: (nodeId: string) => void
}> = ({ node, now, isRoot = false, isSelected = false, onSelect }) => {
	const detailLine = isRoot ? buildRootDetailLine(node) : buildChildDetailLine(node, now)

	return (
		<button
			type="button"
			aria-pressed={isSelected}
			title={`${node.title} — ${node.status}`}
			data-testid={isRoot ? "agent-map-root" : "agent-map-node"}
			onClick={() => onSelect(node.id)}
			className={cn(
				"w-full rounded-md border border-[var(--vscode-panel-border)] bg-[var(--vscode-editorWidget-background)] px-3 py-2 text-left cursor-pointer",
				"hover:bg-[var(--vscode-list-hoverBackground)]",
				"motion-safe:transition-colors",
				isSelected &&
					"ring-1 ring-[var(--vscode-focusBorder)] outline-none bg-[var(--vscode-list-activeSelectionBackground)]",
			)}>
			<span className="flex items-center gap-2">
				<span
					aria-hidden="true"
					className="size-2 rounded-full shrink-0"
					style={{ backgroundColor: agentMapStatusColor(node.status) }}
				/>
				{/* The dot's colour is the only VISUAL carrier of status, and `title` is not reliably
				    announced. Put the word itself in the accessible name, off-screen. */}
				<span className="sr-only">{`Status: ${node.status}.`}</span>
				<span
					className={cn(
						"line-clamp-2 break-words",
						isRoot ? "font-semibold text-sm" : "text-sm font-normal",
					)}>
					{node.title}
				</span>
			</span>
			{detailLine !== null && (
				<span className="block text-xs text-[var(--vscode-descriptionForeground)] mt-0.5">{detailLine}</span>
			)}
		</button>
	)
}

// Root card: model identity and how much of the context window the conversation
// occupies. Either part may be absent; the line disappears when both are.
function buildRootDetailLine(node: AgentMapNode): string | null {
	const parts: string[] = []
	if (node.modelId) {
		parts.push(node.modelId)
	}
	if (typeof node.contextTokens === "number") {
		parts.push(`${formatAgentMapTokens(node.contextTokens)} tokens in context`)
	}
	return parts.length > 0 ? parts.join(" · ") : null
}

// Child card: elapsed time (wall time while running, total once finished) and
// token usage. A node with neither gets no second line at all — an empty or
// dashed line would read as data where there is none.
function buildChildDetailLine(node: AgentMapNode, now: number): string | null {
	const parts: string[] = []
	const durationMs = agentMapNodeDurationMs(node, now)
	if (durationMs !== undefined) {
		parts.push(formatAgentMapDuration(durationMs))
	}
	const totalTokens = agentMapTotalTokens(node.usage)
	if (totalTokens > 0) {
		parts.push(`${formatAgentMapTokens(totalTokens)} tokens`)
	}
	return parts.length > 0 ? parts.join(" · ") : null
}

