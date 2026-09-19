import { HostProvider } from "@/hosts/host-provider"
import type { CallGraphRequest, CallGraphResult } from "../../interfaces/CallGraph"
import type { ICallGraphTrait } from "../../interfaces/IToolEnvironment"

/**
 * Builds the call-graph trait on top of the host bridge's `getCallHierarchy` RPC, exactly as
 * `DiagnosticsTraitBuilder` builds on `getDiagnostics`. Thin by design: every call-hierarchy
 * semantic (symbol resolution, the identifier-position fix, the visited set, depth clamping, the
 * node cap) lives behind the host seam, because only the host has the live language server.
 */
export function buildCallGraphTrait(): ICallGraphTrait {
	return {
		get: async (request: CallGraphRequest): Promise<CallGraphResult> => {
			const response = await HostProvider.workspace.getCallHierarchy({
				symbol: request.symbol,
				...(request.filePath !== undefined ? { filePath: request.filePath } : {}),
				direction: request.direction,
				...(request.depth !== undefined ? { depth: request.depth } : {}),
			})
			const nodes = response.nodes ?? []
			return {
				resolved: response.resolved,
				unresolvedReason: response.unresolvedReason ?? "",
				nodes,
				// The root alone (depth 0) is not a result: resolved with only the root means the
				// language server looked and found nothing on the requested side. That distinction is
				// the whole point of the separate `empty` flag — see CallGraphResult.
				empty: response.resolved && nodes.length <= 1,
			}
		},
	}
}

