import type { DiracToolSpec } from "@/shared/tools"
import type { IDiracTool } from "../../interfaces/IDiracTool"
import { CallGraphTool, call_graph_spec } from "./CallGraphTool"

export const spec: DiracToolSpec = call_graph_spec

export function create(): IDiracTool {
	return new CallGraphTool()
}

