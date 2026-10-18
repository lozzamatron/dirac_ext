import type { DiracToolSpec } from "@shared/tools"
import { requireArguments, requireGoalTrait } from "../../goal/GoalToolInput"
import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"

export const wait_for_goal_events_spec: DiracToolSpec = {
	id: "wait_for_goal_events",
	name: "wait_for_goal_events",
	description: "Wait for the next ordered Goal event batch or a configured intervention deadline.",
}

export class WaitForGoalEventsTool implements IDiracTool {
	spec(): DiracToolSpec {
		return wait_for_goal_events_spec
	}

	supportedSurfaces() {
		return ["all" as const]
	}

	async processCall(input: unknown, environment: IToolEnvironment): Promise<string> {
		requireArguments(input)
		return requireGoalTrait(environment).waitForEvents()
	}
}
