/**
 * Shared call-graph types for the `call_graph` tool (WP7) and its host-backed trait.
 *
 * The trait and the tool both live against these types so that `IToolEnvironment.ts` stays a plain
 * list of traits and never grows call-graph vocabulary of its own.
 */

/**
 * Direction of the call-hierarchy walk: who calls the symbol (`callers`), what the symbol calls
 * (`callees`), or the transitive set of callers (`impact`).
 */
export type CallGraphDirection = "callers" | "callees" | "impact"

/**
 * One node of the call hierarchy. Nodes arrive parent-before-child, so `parentIndex` always points
 * at an EARLIER index and a renderer can emit a tree in a single pass without re-deriving one.
 */
export interface CallGraphNode {
	/** Bare symbol name as the language server reports it (may carry a signature, e.g. `name()`). */
	name: string
	/** The language server's own qualifier, often the containing type. Empty when it has none. */
	detail: string
	/** File URI string of the node's declaration. */
	uri: string
	/** 1-based line of the node's declaration, for display and for clickable card locations. */
	line: number
	/** Symbol kind as reported by the language server, e.g. "function", "method". */
	kind: string
	/** Distance from the resolved symbol; 0 is the symbol itself. */
	depth: number
	/** Index into the nodes array of this node's parent; -1 for the root. */
	parentIndex: number
}

/** Parameters for one call-graph query, forwarded verbatim to the host bridge. */
export interface CallGraphRequest {
	/** Bare symbol name, e.g. `buildFleetSnapshot` — no parentheses, no qualifiers. */
	symbol: string
	/** Optional file path that disambiguates when the same name exists in several files. */
	filePath?: string
	/** Which side of the hierarchy to walk. */
	direction: CallGraphDirection
	/** `impact` only: transitive levels; the host defaults to 2 and clamps to 1–5. */
	depth?: number
}

/**
 * The outcome of one call-graph query.
 *
 * `resolved` and `empty` are SEPARATE booleans on purpose. "No callers" is a FINDING about the
 * code — the language server resolved the symbol, actually looked, and found nothing on the
 * requested side. "I could not look" is a failure to observe the code at all. Collapsing the two
 * into one flag is exactly how an agent concludes a function is dead and deletes live code when
 * nobody actually checked its callers.
 */
export interface CallGraphResult {
	/** False when the language server could not locate the symbol at all; `unresolvedReason` then says why. */
	resolved: boolean
	/** Plain text for the model explaining the failure; empty when `resolved` is true. */
	unresolvedReason: string
	/** Hierarchy nodes, parent before child; includes the resolved symbol itself at depth 0. */
	nodes: CallGraphNode[]
	/**
	 * True when the symbol WAS resolved and the requested side of its hierarchy is empty. The root
	 * alone (depth 0) is not a result: resolved with only the root means the language server looked
	 * and found nothing there.
	 */
	readonly empty: boolean
}

/**
 * Host-backed trait that resolves a symbol and walks its call hierarchy through the host's live
 * language server — the only caller-finding capability Dirac has, since `inspect_ast` is
 * tree-sitter and can find a definition but never a CALLER.
 */
export interface ICallGraphTrait {
	get(request: CallGraphRequest): Promise<CallGraphResult>
}

