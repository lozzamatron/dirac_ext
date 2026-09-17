// Connector cell for one child row of the Agent Map. This is plain CSS rather
// than SVG on purpose: an SVG connector needs measured endpoints, and measured
// connectors break the moment a card's title wraps to a second line and shifts
// the row's vertical centre. Anchoring lines to percentage positions of a
// full-height cell keeps them correct under any reflow, with zero measurement.
import type React from "react"
import { cn } from "@/lib/utils"

// Renders the connector for ONE child row: a vertical trunk segment plus a
// short horizontal stub into that row's card. Place it in a fixed-width grid
// column to the left of the card. Consecutive rows' trunk segments join into
// one continuous line because each segment spans the full row height except
// where it must stop: at the first card's centre on top, the last card's
// centre on bottom. A single child renders no trunk at all — one stub alone
// would draw a floating line with nothing to connect to.
export const AgentMapConnector: React.FC<{ isFirst: boolean; isLast: boolean }> = ({ isFirst, isLast }) => {
	const isOnly = isFirst && isLast
	return (
		<div aria-hidden="true" className="relative h-full w-full">
			{!isOnly && (
				<div
					className={cn(
						"absolute left-1/2 w-px -translate-x-1/2 bg-[var(--vscode-panel-border)]",
						isFirst ? "top-1/2 bottom-0" : isLast ? "top-0 bottom-1/2" : "inset-y-0",
					)}
				/>
			)}
			<div className="absolute top-1/2 left-1/2 right-0 h-px -translate-y-1/2 bg-[var(--vscode-panel-border)]" />
		</div>
	)
}

