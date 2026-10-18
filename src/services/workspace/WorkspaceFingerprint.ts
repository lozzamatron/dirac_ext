import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, opendir, readlink } from "node:fs/promises"
import * as path from "node:path"

const EXCLUDED_DIRECTORY_NAMES = new Set([
	".git",
	".dirac-cache",
	".dirac-symbol-index",
	".gradle",
	".idea",
	".mypy_cache",
	".next",
	".nuxt",
	".parcel-cache",
	".pytest_cache",
	".ruff_cache",
	".sass-cache",
	".venv",
	".vs",
	".vscode",
	"__pycache__",
	"coverage",
	"deps",
	"env",
	"node_modules",
	"Pods",
	"pycache",
	"venv",
	"vendor",
])

function compareNames(left: string, right: string): number {
	if (left < right) return -1
	if (left > right) return 1
	return 0
}

interface FingerprintBudget {
	signal: AbortSignal
	entries: number
	bytes: number
}

async function fingerprintFile(filePath: string, budget: FingerprintBudget): Promise<string> {
	const hash = createHash("sha256")
	for await (const chunk of createReadStream(filePath, { signal: budget.signal })) {
		budget.bytes -= chunk.length
		if (budget.bytes < 0)
			throw new Error("Workspace fingerprint exceeded its byte budget; no partial fingerprint was accepted.")
		hash.update(chunk)
	}
	return hash.digest("hex")
}

async function appendDirectoryFingerprint(
	hash: ReturnType<typeof createHash>,
	root: string,
	relativeDirectory: string,
	budget: FingerprintBudget,
): Promise<void> {
	const directory = path.join(root, relativeDirectory)
	budget.signal.throwIfAborted()
	const entries = []
	for await (const entry of await opendir(directory)) {
		budget.signal.throwIfAborted()
		if (--budget.entries < 0)
			throw new Error("Workspace fingerprint exceeded its entry budget; no partial fingerprint was accepted.")
		entries.push(entry)
	}
	entries.sort((left, right) => compareNames(left.name, right.name))

	for (const entry of entries) {
		budget.signal.throwIfAborted()
		if (entry.isDirectory() && EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue

		const relativePath = path.join(relativeDirectory, entry.name)
		const absolutePath = path.join(root, relativePath)
		if (entry.isDirectory()) {
			await appendDirectoryFingerprint(hash, root, relativePath, budget)
			continue
		}

		const stats = await lstat(absolutePath)
		if (stats.isSymbolicLink()) {
			hash.update(JSON.stringify(["symlink", relativePath, await readlink(absolutePath)]))
			continue
		}
		if (!stats.isFile()) continue

		hash.update(JSON.stringify(["file", relativePath, await fingerprintFile(absolutePath, budget)]))
	}
}

/** Returns a deterministic fingerprint of workspace file paths and bytes, excluding dependency and VCS metadata. */
export async function fingerprintWorkspaceRoots(
	workspaceRoots: readonly string[],
	options: { signal?: AbortSignal; maxEntries?: number; maxBytes?: number; timeoutMs?: number } = {},
): Promise<string> {
	const deadline = AbortSignal.timeout(options.timeoutMs ?? 30_000)
	const budget: FingerprintBudget = {
		signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
		entries: options.maxEntries ?? 100_000,
		bytes: options.maxBytes ?? 512 * 1024 * 1024,
	}
	budget.signal.throwIfAborted()
	const roots = [...new Set(workspaceRoots.map((root) => path.resolve(root)))].sort(compareNames)
	if (roots.length === 0) throw new Error("No workspace roots are available for completion verification.")

	const hash = createHash("sha256")
	for (let index = 0; index < roots.length; index += 1) {
		const root = roots[index]
		const stats = await lstat(root)
		if (!stats.isDirectory()) throw new Error(`Completion verification workspace root is not a directory: ${root}`)
		hash.update(JSON.stringify(["root", index, path.basename(root)]))
		await appendDirectoryFingerprint(hash, root, "", budget)
	}
	return hash.digest("hex")
}
