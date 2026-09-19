import { formatResponse } from "@core/formatResponse"
import { TOOL_EXAMPLES } from "@core/tool-examples"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracIcon } from "@shared/icons"
import { DiracDefaultTool, type DiracToolSpec } from "@shared/tools"
import { getErrorMessage } from "@/shared/errors"
import type { CallGraphDirection, CallGraphNode, CallGraphResult } from "../../interfaces/CallGraph"
import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { ICardHandle, IToolEnvironment } from "../../interfaces/IToolEnvironment"
import type { SurfaceType } from "../../interfaces/SurfaceType"
import { ToolExecutionDeadline, ToolTimeoutError } from "../../runtime/ToolExecutionDeadline"
import { presentToolTimeout } from "../../runtime/ToolTimeoutPresentation"

/** Model-facing arguments for one `call_graph` call, before validation. */
export interface CallGraphArgs {
	operation: string
	symbol: string
	path?: string
	depth?: number
}

/** Validated and normalized arguments; `operation` is narrowed to the real enum. */
interface ValidatedCallGraphArgs {
	operation: CallGraphDirection
	symbol: string
	path?: string
	depth?: number
}

type CallGraphValidation =
	| { valid: true; args: ValidatedCallGraphArgs }
	| { valid: false; message: string }

const MIN_DEPTH = 1
const MAX_DEPTH = 5

/**
 * Validates raw model arguments. The model supplies JSON, not typed values, so every field is
 * checked at runtime even though `CallGraphArgs` types them; a bad call must come back as a
 * correctable error string, never as a thrown exception.
 */
function validateCallGraphArgs(rawArgs: CallGraphArgs): CallGraphValidation {
	const symbol = typeof rawArgs.symbol === "string" ? rawArgs.symbol.trim() : ""
	if (symbol.length === 0) {
		return {
			valid: false,
			message:
				'The `symbol` parameter is required and must be a non-empty bare symbol name, for example "buildFleetSnapshot". Do not include parentheses or qualifiers.',
		}
	}
	const operation = rawArgs.operation
	if (operation !== "callers" && operation !== "callees" && operation !== "impact") {
		return {
			valid: false,
			message: 'The `operation` parameter must be one of "callers", "callees", or "impact".',
		}
	}
	const path = typeof rawArgs.path === "string" && rawArgs.path.trim().length > 0 ? rawArgs.path.trim() : undefined
	let depth: number | undefined
	if (rawArgs.depth !== undefined) {
		if (typeof rawArgs.depth !== "number" || !Number.isFinite(rawArgs.depth)) {
			return { valid: false, message: `The \`depth\` parameter must be a number between ${MIN_DEPTH} and ${MAX_DEPTH}.` }
		}
		depth = Math.min(MAX_DEPTH, Math.max(MIN_DEPTH, Math.round(rawArgs.depth)))
	}
	return {
		valid: true,
		args: {
			operation,
			symbol,
			...(path !== undefined ? { path } : {}),
			...(depth !== undefined ? { depth } : {}),
		},
	}
}

/**
 * Answers "who calls this" and "what breaks if I change this" through the live language server,
 * via the `ICallGraphTrait`. One card per call; the returned text keeps three outcomes
 * distinguishable in words (unresolved / resolved-but-empty / resolved-with-nodes).
 */
export class CallGraphTool implements IDiracTool<CallGraphArgs, string> {
	public spec(): DiracToolSpec {
		return call_graph_spec
	}

	/**
	 * IDE only. There is no language server in the CLI surface, and a tool that can only ever answer
	 * "unresolved" is worse than a tool that is absent — the model would read every failure as
	 * evidence about the code.
	 */
	public supportedSurfaces(): SurfaceType[] {
		return ["ide"]
	}

	public async processCall(rawArgs: CallGraphArgs, env: IToolEnvironment): Promise<string> {
		const validation = validateCallGraphArgs(rawArgs)
		if (!validation.valid) {
			this.incrementMistakeCount(env)
			if (!env.config.isSubagentExecution) {
				await env.ui.upsertText(`Dirac tried to use call_graph with invalid arguments. ${validation.message}`).catch(() => undefined)
			}
			const example = TOOL_EXAMPLES[DiracDefaultTool.CALL_GRAPH]
			return formatResponse.toolError(`${validation.message}${example ? `\n\nExample: ${example}` : ""}`)
		}

		const args = validation.args
		const deadline = new ToolExecutionDeadline(this.spec().name)

		let card: ICardHandle | undefined
		if (!env.config.isSubagentExecution) {
			try {
				card = await env.ui.createCard({
					header: this.runningHeader(args.operation, args.symbol),
					icon: DiracIcon.SYMBOL_FIND,
					status: CardStatus.RUNNING,
					collapsed: true,
					rawInput: {
						tool: DiracDefaultTool.CALL_GRAPH,
						operation: args.operation,
						symbol: args.symbol,
						...(args.path !== undefined ? { path: args.path } : {}),
						...(args.depth !== undefined ? { depth: args.depth } : {}),
					},
				})
			} catch (error) {
				// Card failure is observability only; the query itself must still run and return text.
				card = undefined
			}
		}

		let result: CallGraphResult
		try {
			result = await deadline.run("resolving the call hierarchy", async () =>
				await env.callGraph.get({
					symbol: args.symbol,
					...(args.path !== undefined ? { filePath: args.path } : {}),
					direction: args.operation,
					...(args.depth !== undefined ? { depth: args.depth } : {}),
				}))
		} catch (error) {
			if (error instanceof ToolTimeoutError) {
				await this.finalizeCardAsError(card, `Could not query ${args.symbol}`, "Timed out while resolving the call hierarchy.")
				return await presentToolTimeout(env, error)
			}
			// A throwing language server must yield a stated failure, never a rejected tool call the
			// model cannot recover from.
			const message = getErrorMessage(error)
			await this.finalizeCardAsError(card, `Could not query ${args.symbol}`, `Call-hierarchy lookup failed: ${message}`)
			return formatResponse.toolError(
				`The call_graph lookup failed: ${message}. The language server may be unavailable or still indexing for this file type; retry once the project is indexed.`,
			)
		}

		const locations = this.locationsFromNodes(result.nodes)
		const observabilityFailures: string[] = []
		if (card) {
			try {
				const terminal = result.resolved ? CardStatus.SUCCESS : CardStatus.ERROR
				await card.update({
					header: this.completedHeader(args.operation, args.symbol, result),
					status: terminal,
					body: this.cardBody(args.operation, result),
					rawOutput: {
						resolved: result.resolved,
						empty: result.empty,
						nodeCount: result.nodes.length,
					},
					locations,
				})
				await card.finalize(terminal)
			} catch (error) {
				observabilityFailures.push(`card update failed: ${getErrorMessage(error)}.`)
			}
		}
		try {
			this.captureTelemetry(args, result, env)
		} catch (error) {
			observabilityFailures.push(`telemetry failed: ${getErrorMessage(error)}.`)
		}
		try {
			env.orchestration.setTaskState("consecutiveMistakeCount", 0)
		} catch (error) {
			observabilityFailures.push(`task-state update failed: ${getErrorMessage(error)}.`)
		}

		const text = this.formatResult(args, result)
		return observabilityFailures.length > 0
			? `${text}\n\nObservability warning: the lookup completed, but ${observabilityFailures.join(" ")}`
			: text
	}

	/**
	 * Renders the result so the three outcomes cannot be blurred:
	 * 1. unresolved — the symbol could not be located, with the host's reason verbatim;
	 * 2. resolved but empty — an explicit "no callers/callees" FINDING;
	 * 3. resolved with nodes — the tree.
	 */
	private formatResult(args: ValidatedCallGraphArgs, result: CallGraphResult): string {
		if (!result.resolved) {
			return [
				`The symbol "${args.symbol}" could not be resolved by the language server, so no call graph was produced.`,
				`Reason: ${result.unresolvedReason}`,
				"This is not evidence that the symbol is unused — nobody looked at its callers. Check the spelling, locate the symbol with inspect_ast (operation: definitions), and retry.",
			].join("\n")
		}

		// 🔴 This branch is the reason `resolved` and `empty` are separate facts. Reaching it means the
		// language server RESOLVED the symbol and found nothing on the requested side — a finding about
		// the code. Blurring it with the unresolved case above ("no callers" rendered like "I could
		// not look", or vice versa) is how an agent concludes a function is dead and deletes live code
		// that actually has callers.
		if (result.empty) {
			const finding = args.operation === "callees"
				? `the language server reports that "${args.symbol}" calls nothing`
				: args.operation === "impact"
					? `the language server reports no callers of "${args.symbol}", direct or transitive`
					: `the language server reports no callers of "${args.symbol}"`
			return `Resolved "${args.symbol}" successfully, and ${finding}. This is a finding about the current code, not a lookup failure: the symbol exists and is indexed, and nothing on the requested side was found.`
		}

		const count = result.nodes.length
		return [
			`Call graph for "${args.symbol}" (${args.operation}), ${count} node${count === 1 ? "" : "s"}:`,
			...result.nodes.map((node) => this.renderNode(node)),
		].join("\n")
	}

	/** One tree line: `name — detail (path:line)`, indented by depth. */
	private renderNode(node: CallGraphNode): string {
		const indent = "  ".repeat(Math.max(0, node.depth))
		const detail = node.detail.length > 0 ? ` — ${node.detail}` : ""
		return `${indent}${node.name}${detail} (${this.uriToPath(node.uri)}:${node.line})`
	}

	/** Clickable locations for the card, deduplicated; the root's own location is included. */
	private locationsFromNodes(nodes: CallGraphNode[]): Array<{ path: string; line?: number }> {
		const unique = new Map<string, { path: string; line: number }>()
		for (const node of nodes) {
			const path = this.uriToPath(node.uri)
			if (path.length === 0) continue
			unique.set(`${path}:${node.line}`, { path, line: node.line })
		}
		return [...unique.values()]
	}

	/** Node URIs are file URI strings; card locations want plain paths. */
	private uriToPath(uri: string): string {
		return uri.startsWith("file://") ? uri.slice("file://".length) : uri
	}

	private runningHeader(operation: CallGraphDirection, symbol: string): string {
		if (operation === "callees") return `Finding callees of ${symbol}`
		if (operation === "impact") return `Tracing impact of ${symbol}`
		return `Finding callers of ${symbol}`
	}

	private completedHeader(operation: CallGraphDirection, symbol: string, result: CallGraphResult): string {
		if (!result.resolved) return `Could not resolve ${symbol}`
		if (result.empty) {
			return operation === "callees" ? `No callees of ${symbol}` : `No callers of ${symbol}`
		}
		const count = result.nodes.length
		if (operation === "callees") return `Found ${count} callee${count === 1 ? "" : "s"} of ${symbol}`
		if (operation === "impact") return `Traced impact of ${symbol}: ${count} node${count === 1 ? "" : "s"}`
		return `Found ${count} caller${count === 1 ? "" : "s"} of ${symbol}`
	}

	private cardBody(operation: CallGraphDirection, result: CallGraphResult): string {
		if (!result.resolved) return result.unresolvedReason
		if (result.empty) return `✓ language server reports no ${this.directionNoun(operation)}`
		const count = result.nodes.length
		return `✓ ${count} node${count === 1 ? "" : "s"}`
	}

	private directionNoun(operation: CallGraphDirection): string {
		if (operation === "callees") return "callees"
		if (operation === "impact") return "callers (direct or transitive)"
		return "callers"
	}

	private async finalizeCardAsError(card: ICardHandle | undefined, header: string, body: string): Promise<void> {
		if (!card) return
		await card.update({ header, status: CardStatus.ERROR, body }).catch(() => undefined)
		await card.finalize(CardStatus.ERROR).catch(() => undefined)
	}

	private captureTelemetry(args: ValidatedCallGraphArgs, result: CallGraphResult, env: IToolEnvironment): void {
		env.telemetry.captureCustomMetadata({
			operation: args.operation,
			symbol: args.symbol,
			resolved: result.resolved,
			empty: result.empty,
			nodeCount: result.nodes.length,
			...(args.depth !== undefined ? { requestedDepth: args.depth } : {}),
		})
	}

	private incrementMistakeCount(env: IToolEnvironment): void {
		const count = env.orchestration.getTaskState("consecutiveMistakeCount")
		env.orchestration.setTaskState("consecutiveMistakeCount", count + 1)
	}
}

export const call_graph_spec: DiracToolSpec = {
	id: DiracDefaultTool.CALL_GRAPH,
	name: "call_graph",
	description:
		'Call-graph queries over the live language server: who calls a symbol, what a symbol calls, and the transitive impact of changing it. This answers "who calls this" and "what breaks if I change this", which inspect_ast structurally cannot: inspect_ast is tree-sitter and can find definitions and references, but never a caller. Use call_graph for orientation and impact analysis before proposing a change. Reads that precede an edit still belong to read_file or inspect_ast, because those need exact source lines and anchors. It never modifies files.',
	parameters: [
		{
			name: "operation",
			required: true,
			type: "string",
			enum: ["callers", "callees", "impact"],
			instruction:
				"Choose by question: callers returns what calls the symbol; callees returns what the symbol calls; impact walks callers transitively to depth and answers what breaks if the symbol changes.",
		},
		{
			name: "symbol",
			required: true,
			type: "string",
			instruction:
				"The bare symbol name, for example buildFleetSnapshot. Do not include parentheses or qualifiers; use path to disambiguate same-named symbols instead.",
		},
		{
			name: "path",
			required: false,
			type: "string",
			instruction: "Optional file path that disambiguates when the same symbol name exists in several files.",
		},
		{
			name: "depth",
			required: false,
			type: "integer",
			instruction: "impact only: transitive levels to walk, default 2, maximum 5. Ignored for callers and callees, which are always one level.",
		},
	],
}

