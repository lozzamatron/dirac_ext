// The chat view's top strip: the Agent Map and Fleet Map buttons on every surface, plus — in an
// editor tab only — a badge naming the surface and a button that opens another tab.
//
// The tab-only half exists because with several views open a user cannot otherwise tell which one
// they are looking at; the sidebar is where Dirac has always lived and needs no label. The Agent Map
// button is on both surfaces because the map is about the conversation, not about where it is shown,
// and a control that only exists in one surface is a control people do not find.
import { EmptyRequest } from "@shared/proto/dirac/common"
import { LayersIcon, NetworkIcon, PlusIcon } from "lucide-react"
import type React from "react"
import { getInstanceId, getSurface } from "@/config/platform.config"
import { UiServiceClient } from "@/shared/api/grpc-client"
import { Button } from "@/shared/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"

interface SurfaceStripProps {
	// Opens the Agent Map. The strip only triggers it; the chat view owns the state and the data,
	// because the map is built from the message list and the Goal, both of which live up there.
	onOpenAgentMap: () => void
}

export const SurfaceStrip: React.FC<SurfaceStripProps> = ({ onOpenAgentMap }) => {
	const surface = getSurface()
	const isTab = surface === "tab"

	const instanceId = getInstanceId()
	const instanceTooltip = instanceId ? `Dirac EXT instance ${instanceId.slice(0, 8)}` : "Dirac EXT tab"

	return (
		<div className="flex-none flex items-center justify-end gap-2 px-4 pt-1 pb-0">
			<Tooltip>
				{/* No "are there agents?" variant: answering that needs a walk over every message on
				    every render, and the map itself already states its own empty case truthfully. */}
				<TooltipContent side="bottom">Agent map</TooltipContent>
				<TooltipTrigger asChild>
					<Button
						aria-label="Agent map"
						className="p-0 h-7"
						data-testid="agent-map-open"
						onClick={onOpenAgentMap}
						size="icon"
						variant="icon">
						<NetworkIcon className="stroke-1" size={16} />
					</Button>
				</TooltipTrigger>
			</Tooltip>
			<Tooltip>
				{/* On every surface, like the Agent Map button: the fleet is about the other views,
				    and a control that exists only in a tab is a control people do not find. */}
				<TooltipContent side="bottom">Fleet map — every Dirac EXT view</TooltipContent>
				<TooltipTrigger asChild>
					<Button
						aria-label="Fleet map"
						className="p-0 h-7"
						data-testid="fleet-map-open"
						onClick={() =>
							UiServiceClient.openFleetMap(EmptyRequest.create({})).catch((error) =>
								console.error("Failed to open the Dirac EXT fleet map:", error),
							)
						}
						size="icon"
						variant="icon">
						<LayersIcon className="stroke-1" size={16} />
					</Button>
				</TooltipTrigger>
			</Tooltip>
			{isTab && (
				<>
					<Tooltip>
						<TooltipContent side="bottom">{instanceTooltip}</TooltipContent>
						<TooltipTrigger asChild>
							<span
								className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-[var(--vscode-panel-border)] text-[var(--vscode-descriptionForeground)] select-none"
								data-testid="surface-badge">
								Tab
							</span>
						</TooltipTrigger>
					</Tooltip>
					<Tooltip>
						<TooltipContent side="bottom">New Dirac EXT tab</TooltipContent>
						<TooltipTrigger asChild>
							<Button
								aria-label="New Dirac EXT tab"
								className="p-0 h-7"
								data-testid="surface-new-tab"
								onClick={() =>
									UiServiceClient.openInNewTab(EmptyRequest.create({})).catch((error) =>
										console.error("Failed to open a new Dirac EXT tab:", error),
									)
								}
								size="icon"
								variant="icon">
								<PlusIcon className="stroke-1" size={16} />
							</Button>
						</TooltipTrigger>
					</Tooltip>
				</>
			)}
		</div>
	)
}
