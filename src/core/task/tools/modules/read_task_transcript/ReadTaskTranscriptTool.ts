import type { DiracToolSpec } from "@shared/tools"
import {
	boundedLimit,
	goalToolJson,
	optionalNonEmptyString,
	requireArguments,
	requireGoalTrait,
	requireNonEmptyString,
} from "../../goal/GoalToolInput"
import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { ToolExecutionDeadline, ToolTimeoutError } from "../../runtime/ToolExecutionDeadline"
import { presentToolTimeout } from "../../runtime/ToolTimeoutPresentation"

const DEFAULT_TRANSCRIPT_LIMIT = 50
const MAXIMUM_TRANSCRIPT_LIMIT = 200

export const read_task_transcript_spec: DiracToolSpec = {
	id: "read_task_transcript",
	name: "read_task_transcript",
	description:
		"Read a chronological transcript page, capped at 32 KiB. Follow nextCursor for more. Oversized messages are returned as fragment.json slices; concatenate consecutive slices by messageIndex and offset to reconstruct the message JSON.",
	parameters: [
		{
			name: "task_id",
			required: true,
			instruction: "Stable contained Task ID.",
			minLength: 1,
		},
		{
			name: "cursor",
			required: false,
			instruction: "Opaque cursor returned by an earlier read_task_transcript call.",
		},
		{
			name: "limit",
			type: "integer",
			required: false,
			instruction: `Page size. Defaults to ${DEFAULT_TRANSCRIPT_LIMIT}; maximum ${MAXIMUM_TRANSCRIPT_LIMIT}.`,
			minimum: 1,
			maximum: MAXIMUM_TRANSCRIPT_LIMIT,
		},
	],
}

export class ReadTaskTranscriptTool implements IDiracTool {
	spec(): DiracToolSpec {
		return read_task_transcript_spec
	}

	supportedSurfaces() {
		return ["all" as const]
	}

	async processCall(input: unknown, environment: IToolEnvironment): Promise<string> {
		const args = requireArguments(input)
		const taskId = requireNonEmptyString(args, "task_id")
		const cursor = optionalNonEmptyString(args, "cursor")
		const limit = boundedLimit(args, DEFAULT_TRANSCRIPT_LIMIT, MAXIMUM_TRANSCRIPT_LIMIT)
		const deadline = new ToolExecutionDeadline(this.spec().name)
		try {
			const result = await deadline.run(
				`reading transcript for ${taskId}`,
				async () => await requireGoalTrait(environment).readTaskTranscript({ taskId, cursor, limit }),
			)
			return goalToolJson(result)
		} catch (error) {
			if (error instanceof ToolTimeoutError) return await presentToolTimeout(environment, error)
			throw error
		}
	}
}
