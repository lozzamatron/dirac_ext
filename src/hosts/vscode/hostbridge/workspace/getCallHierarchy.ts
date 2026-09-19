import * as vscode from "vscode"
import type { CallHierarchyNode, GetCallHierarchyRequest, GetCallHierarchyResponse } from "@/shared/proto/host/workspace"
import { Logger } from "@/shared/services/Logger"

// A hub function can have hundreds of callers; an unbounded graph is an answer nobody can read, and a
// partial graph returned as if it were whole is a wrong answer. When the cap trims the walk, the
// response says so instead of staying silent.
const MAX_NODES = 500

// The identifier scan is bounded because a workspace symbol's range can span an entire minified or
// generated file; without this bound the "find the identifier" step becomes a multi-thousand-line
// scan on every call, exactly the failure the spec warns against.
const MAX_SCAN_LINES = 50

const DEFAULT_DEPTH = 2
const MIN_DEPTH = 1
const MAX_DEPTH = 5

type CommandOutcome<T> = { ok: true; value: T | undefined } | { ok: false; message: string }

/**
 * WP7 (D2): resolves a symbol and walks its call hierarchy through the host's live language server.
 *
 * Dirac's own inspect_ast is tree-sitter — it can find a definition, but never a CALLER. This lives
 * behind the host bridge (like diagnostics) because only the host has the live language server.
 *
 * `resolved: false` is an ordinary outcome, not an error: a symbol the language server cannot see
 * (no language extension, an unindexed project, a typo) must come back as a stated fact the model
 * can act on — never as a rejected RPC, and never as an empty success, which would read as
 * "nothing calls this", a very different and much more dangerous answer.
 */
export async function getCallHierarchy(request: GetCallHierarchyRequest): Promise<GetCallHierarchyResponse> {
	const symbol = (request.symbol ?? "").trim()
	if (!symbol) {
		// Fail before touching any provider: an empty query would otherwise be answered with the
		// provider's unfiltered results and look like a successful resolution.
		return unresolved('No symbol was given. Pass the bare name of a function or method, e.g. "buildFleetSnapshot".')
	}

	const direction = request.direction
	if (direction !== "callers" && direction !== "callees" && direction !== "impact") {
		return unresolved(`Unknown direction "${String(direction)}". Use "callers", "callees" or "impact".`)
	}

	// Step 1 — the language server must know the symbol at all.
	const found = await executeCommandSafe<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", symbol)
	if (!found.ok) {
		return unresolved(`The language server threw while looking up "${symbol}": ${found.message}`)
	}
	const symbols = found.value
	if (!symbols || symbols.length === 0) {
		return unresolved(
			`The language server has no workspace symbol matching "${symbol}". It may not be indexed yet, the file's language extension may be missing, or the name may be misspelled.`,
		)
	}

	// Step 2 — tolerant name matching. TypeScript reports function symbols as "buildFleetSnapshot()",
	// with parentheses, so a raw `s.name === symbol` comparison never matches.
	const candidate = selectCandidate(symbols, symbol, request.filePath)
	if (!candidate) {
		return unresolved(`The language server returned no usable candidate for "${symbol}".`)
	}

	// Step 3 — resolve the IDENTIFIER's position. This is the whole fix: the candidate's
	// location.range.start is the start of the DECLARATION (the `export` keyword), and
	// prepareCallHierarchy returns nothing there (measured: 0 results at range.start, 1 result at the
	// identifier's column on the same line).
	const bareName = strippedName(symbol)
	let located: { position: vscode.Position; approximate: boolean }
	try {
		const document = await vscode.workspace.openTextDocument(candidate.location.uri)
		located = findIdentifierPosition(document, bareName, candidate.location.range)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		Logger.warn(`WP7 call_graph: could not open ${candidate.location.uri.toString()} to locate the identifier: ${message}`)
		located = { position: candidate.location.range.start, approximate: true }
	}

	// Step 4 — prepare the hierarchy at the identifier's position.
	const prepared = await executeCommandSafe<vscode.CallHierarchyItem[]>(
		"vscode.prepareCallHierarchy",
		candidate.location.uri,
		located.position,
	)
	if (!prepared.ok) {
		return unresolved(
			`The symbol "${symbol}" was found, but the language server threw while preparing its call hierarchy: ${prepared.message}`,
		)
	}
	const items = prepared.value
	const root = items && items.length > 0 ? items[0] : undefined
	if (!root) {
		let reason = `The symbol "${symbol}" was found, but the language server provides no call hierarchy at that position.`
		if (located.approximate) {
			// Only surface the approximation caveat here, when the empty result might be its cause —
			// not on every approximate-position call, where the hierarchy may still resolve fine.
			reason +=
				" The position used was approximate (the identifier itself could not be located on the declaration), which is a known cause of an empty result."
		}
		return unresolved(reason)
	}

	// Step 5 — walk. callers/callees are one level; impact is transitive incoming calls.
	const maxDepth = direction === "impact" ? clampDepth(request.depth) : 1
	const useIncoming = direction !== "callees"

	const nodes: CallHierarchyNode[] = []
	// Step 6 — visited set, claimed BEFORE descending. Recursive code is ordinary; without this,
	// impact on a recursive function walks forever (each visit re-enqueues its caller).
	const visited = new Set<string>()
	let trimmedByCap = false

	visited.add(visitKey(root))
	// Step 7 — the root is the resolved symbol itself: depth 0, parentIndex -1, emitted first so every
	// parentIndex that follows points backwards and the caller can render a tree directly.
	nodes.push(toNode(root, 0, -1))

	const queue: Array<{ item: vscode.CallHierarchyItem; depth: number; selfIndex: number }> = [
		{ item: root, depth: 0, selfIndex: 0 },
	]

	while (queue.length > 0) {
		const entry = queue.shift()
		if (!entry) {
			break
		}
		if (entry.depth >= maxDepth) {
			continue
		}

		let childItems: vscode.CallHierarchyItem[]
		if (useIncoming) {
			// Incoming calls expose the CALLER on `.from`. Outgoing calls expose the CALLEE on `.to` —
			// mixing these up yields a plausible, wrong graph.
			const calls = await executeCommandSafe<vscode.CallHierarchyIncomingCall[]>("vscode.provideIncomingCalls", entry.item)
			if (!calls.ok) {
				return unresolved(`The language server threw while walking the call hierarchy of "${symbol}": ${calls.message}`)
			}
			childItems = (calls.value ?? []).map((call) => call.from)
		} else {
			const calls = await executeCommandSafe<vscode.CallHierarchyOutgoingCall[]>("vscode.provideOutgoingCalls", entry.item)
			if (!calls.ok) {
				return unresolved(`The language server threw while walking the call hierarchy of "${symbol}": ${calls.message}`)
			}
			childItems = (calls.value ?? []).map((call) => call.to)
		}

		for (const childItem of childItems) {
			const key = visitKey(childItem)
			if (visited.has(key)) {
				continue
			}
			// Claim before descending, not when dequeuing: the same function reached via two siblings
			// must be enqueued once, or the walk fans out exponentially on diamond-shaped graphs.
			visited.add(key)
			if (nodes.length >= MAX_NODES) {
				trimmedByCap = true
				queue.length = 0
				break
			}
			nodes.push(toNode(childItem, entry.depth + 1, entry.selfIndex))
			queue.push({ item: childItem, depth: entry.depth + 1, selfIndex: nodes.length - 1 })
		}
	}

	const response: GetCallHierarchyResponse = { resolved: true, unresolvedReason: "", nodes }
	if (trimmedByCap) {
		// A partial graph returned as if whole is a wrong answer, not a small one — say so.
		response.unresolvedReason = `The walk was truncated at ${MAX_NODES} nodes — this graph is partial, not whole.`
	}
	return response
}

/**
 * Removes a trailing `(...)` from a workspace-symbol name. TypeScript's symbol provider reports
 * functions as `"buildFleetSnapshot()"`, so an exact comparison against the bare name never matches.
 */
function strippedName(name: string): string {
	if (!name.endsWith(")")) {
		return name
	}
	const open = name.lastIndexOf("(")
	if (open === -1) {
		return name
	}
	return name.slice(0, open).trim()
}

/**
 * Picks which workspace symbol to walk, in the spec's preference order: an exact (stripped) name
 * match inside the requested file, then any exact match, then the first candidate the provider
 * returned. Path fragments are compared with backslashes normalised to slashes so a Windows-style
 * path from the model still matches.
 */
function selectCandidate(
	symbols: vscode.SymbolInformation[],
	symbol: string,
	filePath: string | undefined,
): vscode.SymbolInformation | undefined {
	const bare = strippedName(symbol)
	const matches = symbols.filter((s) => strippedName(s.name) === bare)
	if (filePath) {
		const needle = filePath.replace(/\\/g, "/")
		const inFile = matches.find((s) => s.location.uri.fsPath.replace(/\\/g, "/").includes(needle))
		if (inFile) {
			return inFile
		}
	}
	const firstMatch = matches.length > 0 ? matches[0] : undefined
	if (firstMatch) {
		return firstMatch
	}
	return symbols.length > 0 ? symbols[0] : undefined
}

/**
 * Finds the position of the symbol's IDENTIFIER — the entire reason this file exists.
 *
 * `prepareCallHierarchy` returns nothing at a declaration's `location.range.start` (the `export`
 * keyword); it must be called on the identifier itself. The search is tolerant because declarations
 * span lines (`export const x = (...) =>`): first the declaration's opening line, then the lines the
 * symbol's range covers — bounded at MAX_SCAN_LINES so a huge range cannot become a long scan. If
 * the identifier is never found, fall back to `range.start` and flag the position as approximate;
 * the caller surfaces that caveat only if the hierarchy then comes back empty.
 */
function findIdentifierPosition(
	document: vscode.TextDocument,
	name: string,
	range: vscode.Range,
): { position: vscode.Position; approximate: boolean } {
	if (range.start.line >= document.lineCount) {
		return { position: range.start, approximate: true }
	}
	// The name is model-supplied and can contain regex metacharacters; escape before building the
	// pattern, and use word boundaries so "snapshot" does not match inside "buildFleetSnapshot".
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const pattern = new RegExp(`\\b${escaped}\\b`)

	const firstLineMatch = pattern.exec(document.lineAt(range.start.line).text)
	if (firstLineMatch) {
		return { position: new vscode.Position(range.start.line, firstLineMatch.index), approximate: false }
	}

	const lastLine = Math.min(range.end.line, range.start.line + MAX_SCAN_LINES - 1, document.lineCount - 1)
	for (let line = range.start.line + 1; line <= lastLine; line++) {
		const match = pattern.exec(document.lineAt(line).text)
		if (match) {
			return { position: new vscode.Position(line, match.index), approximate: false }
		}
	}

	return { position: range.start, approximate: true }
}

/**
 * Runs a VS Code command, converting a throwing language server into a reported outcome instead of a
 * rejected host call — the host bridge must always answer, even when the provider is broken.
 */
async function executeCommandSafe<T>(command: string, ...args: unknown[]): Promise<CommandOutcome<T>> {
	try {
		return { ok: true, value: await vscode.commands.executeCommand<T>(command, ...args) }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		Logger.warn(`WP7 call_graph: "${command}" threw: ${message}`)
		return { ok: false, message }
	}
}

/**
 * Identity of a call-hierarchy item for the visited set: same file, same line, same name is the same
 * function no matter which path reached it.
 */
function visitKey(item: vscode.CallHierarchyItem): string {
	return `${item.uri.toString()}#${item.range.start.line}#${item.name}`
}

/**
 * Converts a call-hierarchy item to a proto node. `line` is 1-based for display; VS Code's
 * `range.start.line` is 0-based, hence the +1.
 */
function toNode(item: vscode.CallHierarchyItem, depth: number, parentIndex: number): CallHierarchyNode {
	return {
		name: item.name,
		detail: item.detail ?? "",
		uri: item.uri.toString(),
		line: item.range.start.line + 1,
		kind: kindName(item.kind),
		depth,
		parentIndex,
	}
}

/** Human-readable symbol kind ("function", "method", …) from the numeric vscode.SymbolKind. */
function kindName(kind: vscode.SymbolKind): string {
	const name = vscode.SymbolKind[kind]
	return typeof name === "string" ? name.toLowerCase() : "unknown"
}

/** Impact depth: default 2, clamped to 1..5 — a model-supplied 0 or 99 must not walk 99 levels. */
function clampDepth(depth: number | undefined): number {
	return Math.min(MAX_DEPTH, Math.max(MIN_DEPTH, depth ?? DEFAULT_DEPTH))
}

/** Builds the "ordinary outcome" response: the symbol could not be resolved, stated as a fact. */
function unresolved(reason: string): GetCallHierarchyResponse {
	return { resolved: false, unresolvedReason: reason, nodes: [] }
}
