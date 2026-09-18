// The Fleet map panel (WP5b): every live Dirac EXT instance as one card with its agent tree
// beneath it. This is the WHOLE panel content, not a modal — the host swaps it in over the chat
// view, so it owns its own header, its own empty state and its own single drawer.
//
// All ordering and layout decisions come from `buildFleetSections`; this file only draws what that
// pure helper returns. The one action offered per instance is Reveal — navigation, not control.
// This is a map, not a remote control: nothing here starts, steers or aborts another instance's
// task.
import type React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useFleetSnapshot } from "@/features/fleet-map/useFleetSnapshot"
import { buildFleetSections, fleetAgentTotal, type FleetSection } from "@/features/fleet-map/buildFleetSections"
import { AgentMapNodeCard } from "@/features/agent-map/AgentMapNodeCard"
import { AgentMapConnector } from "@/features/agent-map/connectors"
import { AgentMapDrawer } from "@/features/agent-map/AgentMapDrawer"
import { FleetServiceClient } from "@/shared/api/grpc-client"
import { StringRequest } from "@shared/proto/dirac/common"
import type { FleetInstanceStatus } from "@shared/fleet"
import { cn } from "@/lib/utils"

/**
 * Maps every `FleetInstanceStatus` onto the dot colour it draws.
 *
 * An exhaustive `Record`, not a switch with a default, so a new upstream status breaks compilation
 * here instead of silently drawing the wrong colour — the same contract
 * `FLEET_STATUS_BY_TASK_STATUS` holds on the host side of the wire.
 */
const FLEET_STATUS_COLOR: Record<FleetInstanceStatus, string> = {
	running: "var(--vscode-charts-orange)",
	waiting: "var(--vscode-charts-yellow)",
	completed: "var(--vscode-descriptionForeground)",
	cancelled: "var(--vscode-disabledForeground)",
	idle: "var(--vscode-descriptionForeground)",
}

/**
 * What the user selected, as the pair (instanceId, nodeId).
 *
 * Node ids are only unique WITHIN an instance — two instances can each have a node with the same
 * id — so tracking the node id alone would select the same-named node in two cards at once and
 * feed the drawer a node from the wrong tree.
 */
interface FleetSelection {
	instanceId: string
	nodeId: string
}

/**
 * The Fleet map panel: one section per live instance, ordered sidebar → tabs → detached by
 * {@link buildFleetSections}, each with its agent tree laid out on an explicit grid.
 *
 * Selection is panel-wide: one drawer serves every section, keyed by the (instanceId, nodeId)
 * pair. Esc clears the selection; the panel itself never closes on Esc because it is not a modal.
 */
export const FleetMapView: React.FC = () => {
	const snapshot = useFleetSnapshot()
	const sections = useMemo(() => buildFleetSections(snapshot), [snapshot])
	const agentTotal = useMemo(() => fleetAgentTotal(sections), [sections])

	const [selected, setSelected] = useState<FleetSelection | null>(null)

	// ONE clock reading per render, shared by every card and the drawer: durations on one screen
	// must agree with each other, and per-card `Date.now()` calls would let a card show 4m59s next
	// to a drawer showing 5m00s for the same node.
	const now = Date.now()

	// The Esc handler reads the selection through a ref so the effect registers ONCE. Putting the
	// selection in the dependency array would tear the listener down and re-add it on every fleet
	// push, and a key pressed in that gap is simply lost — the same trap AgentMapOverlay avoids.
	const selectedRef = useRef<FleetSelection | null>(selected)
	selectedRef.current = selected

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") {
				return
			}
			if (selectedRef.current === null) {
				// Nothing selected: Esc has nothing to peel here. The panel is not a modal, so it does
				// not close, and the key is left for whatever else might be listening.
				return
			}
			event.preventDefault()
			setSelected(null)
		}
		window.addEventListener("keydown", onKeyDown)
		return () => window.removeEventListener("keydown", onKeyDown)
	}, [])

	// Resolve the selection to a node by looking it up inside ITS instance's section — never by
	// node id across the whole fleet, for the reason recorded on `FleetSelection`.
	const selectedNode = useMemo(() => {
		if (!selected) {
			return null
		}
		const section = sections.find((candidate) => candidate.instance.instanceId === selected.instanceId)
		const row = section?.rows.find((candidate) => candidate.node.id === selected.nodeId)
		return row?.node ?? null
	}, [selected, sections])

	if (sections.length === 0) {
		// Never a blank panel: an empty fleet is a state the user reached deliberately (every other
		// view closed), so it gets a sentence, not silence.
		return (
			<div className="p-4" data-testid="fleet-empty">
				<p className="text-sm text-[var(--vscode-descriptionForeground)]">No other Dirac EXT views are open.</p>
			</div>
		)
	}

	const instanceWord = sections.length === 1 ? "instance" : "instances"
	const agentWord = agentTotal === 1 ? "agent" : "agents"

	return (
		<div className="flex flex-col gap-4 p-4">
			<header data-testid="fleet-map-header">
				<h2 className="text-lg font-semibold">
					{`Fleet — ${sections.length} ${instanceWord} · ${agentTotal} ${agentWord}`}
				</h2>
				<p className="text-xs text-[var(--vscode-descriptionForeground)] mt-1">
					Every live Dirac EXT view and the agents running in it.
				</p>
			</header>
			{sections.map((section) => (
				<FleetInstanceSection
					key={section.instance.instanceId}
					section={section}
					now={now}
					isSelected={(nodeId) => selected?.instanceId === section.instance.instanceId && selected.nodeId === nodeId}
					onSelect={(nodeId) => setSelected({ instanceId: section.instance.instanceId, nodeId })}
				/>
			))}
			{selectedNode && <AgentMapDrawer node={selectedNode} now={now} onClose={() => setSelected(null)} />}
		</div>
	)
}

// One instance's card: header row (dot, title, surface badge, detached chip, Reveal) plus its
// agent tree on the explicit grid. Split from `FleetMapView` so the panel-level selection logic
// stays out of the per-instance markup.
const FleetInstanceSection: React.FC<{
	section: FleetSection
	now: number
	isSelected: (nodeId: string) => boolean
	onSelect: (nodeId: string) => void
}> = ({ section, now, isSelected, onSelect }) => {
	const { instance, rows } = section
	return (
		<section
			data-testid="fleet-instance"
			data-instance-id={instance.instanceId}
			className="rounded-lg border border-[var(--vscode-panel-border)] bg-[var(--vscode-editorWidget-background)] p-4">
			<div className="flex items-center gap-2">
				<span
					aria-hidden="true"
					// The status in a machine-readable attribute as well as a colour: a browser test can
					// only read a colour back as an rgb() string, which says nothing about WHICH status
					// it means and passes just as happily when the mapping is wrong.
					data-fleet-status={instance.status}
					className="size-2 rounded-full shrink-0"
					style={{ backgroundColor: FLEET_STATUS_COLOR[instance.status] }}
				/>
				{/* The dot's colour is the only VISUAL carrier of status, and colour alone is not a
				    status indicator anyone can read — put the word in the accessible name, off-screen. */}
				<span className="sr-only">{`Status: ${instance.status}.`}</span>
				<span
					data-testid="fleet-instance-title"
					title={instance.title}
					className="flex-1 min-w-0 truncate text-sm font-semibold">
					{instance.title}
				</span>
				<span
					data-testid="fleet-surface-badge"
					className="shrink-0 rounded border border-[var(--vscode-panel-border)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--vscode-descriptionForeground)]">
					{instance.surface === "sidebar" ? "Sidebar" : "Tab"}
				</span>
				{instance.detached && (
					<span
						data-testid="fleet-detached-chip"
						title="This task outlived its window and is running without one. Reveal reopens a view for it."
						className="shrink-0 rounded border border-[var(--vscode-panel-border)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--vscode-charts-yellow)]">
						Detached
					</span>
				)}
				<button
					type="button"
					data-testid="fleet-reveal"
					aria-label={`Reveal ${instance.title}`}
					onClick={() =>
						FleetServiceClient.revealInstance(StringRequest.create({ value: instance.instanceId })).catch(console.error)
					}
					className={cn(
						// A visible border and background AT REST, not only on hover: a hover-only
						// affordance is not an affordance — keyboard users and touch never see hover.
						"shrink-0 rounded-md border border-[var(--vscode-panel-border)] bg-[var(--vscode-editorWidget-background)] px-2 py-0.5 text-xs cursor-pointer",
						"hover:bg-[var(--vscode-list-hoverBackground)]",
						"motion-safe:transition-colors",
					)}>
					Reveal
				</button>
			</div>
			{rows.length === 0 ? (
				<p className="mt-3 text-xs text-[var(--vscode-descriptionForeground)]" data-testid="fleet-empty-instance">
					No conversation yet
				</p>
			) : (
				<div
					className="mt-3 grid items-center gap-y-2"
					style={{
						gridTemplateColumns: "minmax(0, 1fr) 40px minmax(0, 1fr) 40px minmax(0, 1fr)",
						// The five explicit columns cover depth 1-3, which is all the host can build
						// (root -> Goal child / subagent -> that child's own subagents). Nothing
						// ENFORCES that, though, so size the implicit columns too: a deeper node then
						// renders narrow-but-readable instead of collapsing into an auto-width sliver.
						gridAutoColumns: "minmax(0, 1fr)",
					}}>
					{/* Every cell is placed EXPLICITLY by column AND row. Auto-placement flows around
					    spans and source order in ways that depend on neither being what you assumed —
					    it once put a card inside the 40px connector column and rendered it one word
					    per line. Never rely on it here. */}
					{rows.map((row) => {
						if (row.depth === 1) {
							// Depth 1 is the root: column 1, no elbow of its own, drawn with `isRoot` so
							// the card shows model identity and context size instead of elapsed time.
							//
							// It SPANS its whole subtree's rows, and carries the stub out to the trunk.
							// Sitting in row 1 alone leaves an 8px gap between its bottom and the elbow
							// below it, so the elbow joins nothing — measured in the browser, invisible
							// to any assertion that only asks whether a connector is present.
							return (
								<div
									key={row.node.id}
									className="relative"
									style={{ gridColumn: 1, gridRow: `${row.row} / span ${row.subtreeSize}` }}>
									<AgentMapNodeCard
										node={row.node}
										now={now}
										isRoot
										isSelected={isSelected(row.node.id)}
										onSelect={onSelect}
									/>
									{row.hasChildren && (
										<div
											aria-hidden="true"
											className="absolute top-1/2 -right-5 h-px w-5 bg-[var(--vscode-panel-border)]"
										/>
									)}
								</div>
							)
						}
						// depth 2 → connector in column 2, card in column 3; depth 3 → connector in
						// column 4, card in column 5. The formulas below generalise that pairing; the
						// agent tree has at most three levels (root / Goal / subagent), so the five
						// template columns cover every row this can produce.
						const connectorColumn = (row.depth - 1) * 2
						const cardColumn = row.depth * 2 - 1
						return (
							<FragmentRow
								key={row.node.id}
								connectorColumn={connectorColumn}
								cardColumn={cardColumn}
								gridRow={row.row}
								rowSpan={row.subtreeSize}
								hasChildren={row.hasChildren}
								isFirst={row.isFirstChild}
								isLast={row.isLastChild}
								node={row.node}
								now={now}
								isSelected={isSelected(row.node.id)}
								onSelect={onSelect}
							/>
						)
					})}
				</div>
			)}
		</section>
	)
}

// One non-root tree row: its connector cell and its card cell, each placed explicitly. Split out
// so the two cells of a row stay adjacent in source order without a wrapper element that would
// break the grid's flat cell list.
const FragmentRow: React.FC<{
	connectorColumn: number
	cardColumn: number
	gridRow: number
	rowSpan: number
	hasChildren: boolean
	isFirst: boolean
	isLast: boolean
	node: Parameters<typeof AgentMapNodeCard>[0]["node"]
	now: number
	isSelected: boolean
	onSelect: (nodeId: string) => void
}> = ({ connectorColumn, cardColumn, gridRow, rowSpan, hasChildren, isFirst, isLast, node, now, isSelected, onSelect }) => (
	<>
		{/* The elbow occupies only THIS row — it joins this node to its own parent's trunk, and a
		    spanning elbow would draw a line down the side of the node's own children. */}
		<div style={{ gridColumn: connectorColumn, gridRow }} className="h-full">
			<AgentMapConnector isFirst={isFirst} isLast={isLast} />
		</div>
		{/* The card spans its own subtree for the same reason the root does: a Goal child with
		    subagents of its own must reach the trunk those subagents hang from. */}
		<div className="relative" style={{ gridColumn: cardColumn, gridRow: `${gridRow} / span ${rowSpan}` }}>
			<AgentMapNodeCard node={node} now={now} isSelected={isSelected} onSelect={onSelect} />
			{hasChildren && (
				<div aria-hidden="true" className="absolute top-1/2 -right-5 h-px w-5 bg-[var(--vscode-panel-border)]" />
			)}
		</div>
	</>
)

