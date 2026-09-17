// The Agent Map modal: root task on the left, one child card per subagent /
// Goal task on the right, joined by CSS connectors. Owns the ticking clock
// that keeps running durations live, the selection state feeding the drawer,
// and the keyboard model (Esc peels the drawer first, then the map).
import { XIcon } from "lucide-react"
import type React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { AgentMapSnapshot } from "@shared/agentMap"
import { isTerminalAgentMapStatus } from "@shared/agentMap"
import { Button } from "@/shared/ui/button"
import { AgentMapDrawer } from "./AgentMapDrawer"
import { AgentMapConnector } from "./connectors"
import { AgentMapNodeCard } from "./AgentMapNodeCard"

export const AgentMapOverlay: React.FC<{
	snapshot: AgentMapSnapshot
	onClose: () => void
}> = ({ snapshot, onClose }) => {
	const [now, setNow] = useState(() => Date.now())
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const panelRef = useRef<HTMLDivElement>(null)

	const root = snapshot.nodes[0]
	const children = useMemo(() => snapshot.nodes.slice(1), [snapshot.nodes])

	// Derived boolean, not the node array: the interval effect must not restart
	// (and never re-fire) just because a parent re-rendered with a new array.
	const hasActiveNode = useMemo(
		() => snapshot.nodes.some((node) => !isTerminalAgentMapStatus(node.status)),
		[snapshot.nodes],
	)

	useEffect(() => {
		if (!hasActiveNode) {
			return
		}
		const interval = window.setInterval(() => setNow(Date.now()), 1000)
		return () => window.clearInterval(interval)
	}, [hasActiveNode])

	// Grab focus on mount so arrow keys reach the overlay instead of scrolling
	// the chat transcript behind the scrim.
	useEffect(() => {
		panelRef.current?.focus()
	}, [])

	// Keep Tab inside the dialog. aria-modal tells assistive technology the rest of the page is
	// inert; it does not stop the browser tabbing into it, so a keyboard user would otherwise land
	// on the chat input behind a scrim they cannot see through.
	useEffect(() => {
		const onTab = (event: KeyboardEvent) => {
			if (event.key !== "Tab") {
				return
			}
			const panel = panelRef.current
			if (!panel) {
				return
			}
			const focusable = Array.from(
				panel.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
			).filter((el) => !el.hasAttribute("disabled"))
			if (focusable.length === 0) {
				event.preventDefault()
				panel.focus()
				return
			}
			const first = focusable[0]
			const last = focusable[focusable.length - 1]
			const active = document.activeElement
			if (!panel.contains(active)) {
				event.preventDefault()
				;(event.shiftKey ? last : first).focus()
				return
			}
			if (!event.shiftKey && active === last) {
				event.preventDefault()
				first.focus()
			} else if (event.shiftKey && active === first) {
				event.preventDefault()
				last.focus()
			}
		}
		window.addEventListener("keydown", onTab)
		return () => window.removeEventListener("keydown", onTab)
	}, [])

	// The handler reads the current children and selection through refs so the effect below can
	// register ONCE. Putting them in the dependency array tears the listener down and re-adds it on
	// every chat update and on every 1s tick, and a key pressed in that gap is simply lost.
	const childrenRef = useRef(children)
	childrenRef.current = children
	const selectedIdRef = useRef(selectedId)
	selectedIdRef.current = selectedId
	const onCloseRef = useRef(onClose)
	onCloseRef.current = onClose

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const children = childrenRef.current
			const selectedId = selectedIdRef.current
			if (event.key === "Escape") {
				// Esc peels one layer at a time: the drawer first, the map only
				// when nothing is selected.
				event.preventDefault()
				if (selectedId !== null) {
					setSelectedId(null)
				} else {
					onCloseRef.current()
				}
				return
			}
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				// The chat transcript behind must not scroll while the map is open.
				event.preventDefault()
				if (children.length === 0) {
					return
				}
				const currentIndex = selectedId === null ? null : children.findIndex((child) => child.id === selectedId)
				let nextIndex: number
				if (currentIndex === null) {
					nextIndex = event.key === "ArrowDown" ? 0 : children.length - 1
				} else if (event.key === "ArrowDown") {
					nextIndex = Math.min(currentIndex + 1, children.length - 1)
				} else {
					nextIndex = Math.max(currentIndex - 1, 0)
				}
				setSelectedId(children[nextIndex].id)
			}
			// Enter is deliberately unhandled: the cards are real buttons, so
			// Enter on a focused card activates it natively.
		}
		window.addEventListener("keydown", onKeyDown)
		return () => window.removeEventListener("keydown", onKeyDown)
	}, [])

	const selectedNode = useMemo(
		() => (selectedId === null ? null : (snapshot.nodes.find((node) => node.id === selectedId) ?? null)),
		[selectedId, snapshot.nodes],
	)

	if (!root) {
		// An overlay with no root is an upstream bug, not an empty state.
		return null
	}


	return (
		// bg-black/50 is the one allowed non-variable value: it is a scrim over
		// whatever is behind, not a theme colour.
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
			onClick={onClose}
			data-testid="agent-map-scrim">
			<div
				ref={panelRef}
				role="dialog"
				aria-modal="true"
				aria-label="Agent map"
				tabIndex={-1}
				data-testid="agent-map-overlay"
				className="w-full max-w-[900px] max-h-[85vh] overflow-auto rounded-lg border border-[var(--vscode-panel-border)] bg-[var(--vscode-editor-background)] p-5 outline-none"
				onClick={(event) => event.stopPropagation()}>
				<div className="flex items-center justify-between">
					<h2 className="text-lg font-semibold">Agent map</h2>
					<Button
						aria-label="Close agent map"
						data-testid="agent-map-close"
						onClick={onClose}
						size="icon"
						variant="icon">
						<XIcon size={16} />
					</Button>
				</div>
				<p className="text-xs text-[var(--vscode-descriptionForeground)] mt-1" data-testid="agent-map-subtitle">
					{children.length === 0
						? "No subagents or Goal tasks in this conversation yet."
						: `${children.length} ${children.length === 1 ? "agent" : "agents"} · click an agent for details`}
				</p>
				<div
					className="mt-4 grid items-center gap-y-2"
					style={{ gridTemplateColumns: "minmax(0, 1fr) 40px minmax(0, 1.2fr)" }}>
					{/* The root spans every child row so it centres vertically against
					    the whole right column, as in the reference. The wrapper also
					    carries the stub that joins the root card to the trunk. */}
					<div
						className="relative"
						style={{ gridColumn: 1, gridRow: `1 / span ${Math.max(children.length, 1)}` }}>
						<AgentMapNodeCard node={root} now={now} isRoot isSelected={selectedId === root.id} onSelect={setSelectedId} />
						{children.length > 0 && (
							<div
								aria-hidden="true"
								className="absolute top-1/2 -right-5 h-px w-5 bg-[var(--vscode-panel-border)]"
							/>
						)}
					</div>
					{/* Every cell is placed EXPLICITLY. Auto-placement flows around the root's row span in
					    ways that depend on source order, and it put the third card inside the 40px
					    connector column — one word per line — the first time this was driven in a browser. */}
					{children.map((child, index) => (
						<AgentMapConnectorCell
							key={`connector-${child.id}`}
							isFirst={index === 0}
							isLast={index === children.length - 1}
							row={index + 1}
						/>
					))}
					{children.map((child, index) => (
						<div key={child.id} style={{ gridColumn: 3, gridRow: index + 1 }}>
							<AgentMapNodeCard
								node={child}
								now={now}
								isSelected={selectedId === child.id}
								onSelect={setSelectedId}
							/>
						</div>
					))}
				</div>
				{selectedNode && (
					<AgentMapDrawer node={selectedNode} now={now} onClose={() => setSelectedId(null)} />
				)}
			</div>
		</div>
	)
}

// Places one connector in column 2 of its child row. Split out so the two
// children.map passes above stay flat: connectors and cards are separate grid
// items in the same row order, which keeps the markup free of nested row wrappers.
const AgentMapConnectorCell: React.FC<{ isFirst: boolean; isLast: boolean; row: number }> = ({ isFirst, isLast, row }) => (
	<div style={{ gridColumn: 2, gridRow: row }} className="h-full">
		<AgentMapConnector isFirst={isFirst} isLast={isLast} />
	</div>
)

