// A small strip shown only when this webview is rendered in an editor tab.
// The sidebar is where Dirac has always lived and is already unambiguous, so
// the strip is deliberately tab-only: it labels the surface and lets the user
// spawn additional tabs without leaving the webview.
import { EmptyRequest } from "@shared/proto/dirac/common"
import { PlusIcon } from "lucide-react"
import type React from "react"
import { getInstanceId, getSurface } from "@/config/platform.config"
import { UiServiceClient } from "@/shared/api/grpc-client"
import { Button } from "@/shared/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"

export const SurfaceStrip: React.FC = () => {
	const surface = getSurface()
	if (surface !== "tab") {
		return null
	}

	const instanceId = getInstanceId()
	const instanceTooltip = instanceId ? `Dirac EXT instance ${instanceId.slice(0, 8)}` : "Dirac EXT tab"

	return (
		<div className="flex-none flex items-center justify-end gap-2 px-4 pt-1 pb-0">
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
		</div>
	)
}
