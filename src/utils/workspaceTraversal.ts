import { execFile } from "node:child_process"
import { type Dirent } from "node:fs"
import { opendir, readFile } from "node:fs/promises"
import * as path from "node:path"
import ignore, { type Ignore } from "ignore"

/** Git is authoritative, including tracked paths, nested ignores and configured excludes. */
export class WorkspaceGitVisibility {
	private constructor(
		private readonly root: string,
		private readonly signal: AbortSignal,
		public readonly isGitWorkspace: boolean,
		private readonly trackedPaths: Set<string>,
		public readonly submodules: Set<string>,
	) { }

	public static async create(root: string, signal: AbortSignal, allowIgnoredRoot = false): Promise<WorkspaceGitVisibility> {
		let result: Awaited<ReturnType<typeof runWorkspaceGit>>
		try {
			result = await runWorkspaceGit(root, ["rev-parse", "--is-inside-work-tree"], signal)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			// File browsing also works on machines without Git; local ignore files remain available.
			return new WorkspaceGitVisibility(root, signal, false, new Set(), new Set())
		}
		if (result.code !== 0 && !result.stderr.includes("not a git repository")) {
			throw new Error(`Unable to determine Git visibility: ${result.stderr}`)
		}
		let isGitWorkspace = result.code === 0 && result.stdout.trim() === "true"
		if (isGitWorkspace && allowIgnoredRoot) {
			const rootIgnore = await runWorkspaceGit(root, ["check-ignore", "."], signal)
			if (rootIgnore.code !== 0 && rootIgnore.code !== 1)
				throw new Error(`Unable to check explicit root visibility: ${rootIgnore.stderr}`)
			if (rootIgnore.code === 0) isGitWorkspace = false
		}
		const trackedPaths = new Set<string>()
		const submodules = new Set<string>()
		if (isGitWorkspace) {
			const tracked = await runWorkspaceGit(root, ["ls-files", "-z", "--stage"], signal)
			if (tracked.code !== 0) throw new Error(`Unable to enumerate tracked paths: ${tracked.stderr}`)
			for (const file of tracked.stdout.split("\0").filter(Boolean)) {
				let relative = path.normalize(file.slice(file.indexOf("\t") + 1))
				if (file.startsWith("160000 ")) submodules.add(relative)
				while (relative !== ".") {
					trackedPaths.add(relative)
					relative = path.dirname(relative)
				}
			}
		}
		return new WorkspaceGitVisibility(root, signal, isGitWorkspace, trackedPaths, submodules)
	}

	public async ignoredPaths(relativePaths: readonly string[]): Promise<Set<string>> {
		this.signal.throwIfAborted()
		const untrackedPaths = relativePaths.filter((entry) => !this.trackedPaths.has(entry))
		if (!this.isGitWorkspace || untrackedPaths.length === 0) return new Set()
		const result = await runWorkspaceGit(
			this.root,
			["check-ignore", "-z", "--stdin"],
			this.signal,
			`${untrackedPaths.map((entry) => entry.split(path.sep).join("/")).join("\0")}\0`,
		)
		if (result.code !== 0 && result.code !== 1) throw new Error(`Git visibility check failed: ${result.stderr}`)
		return new Set(
			result.stdout
				.split("\0")
				.filter(Boolean)
				.map((entry) => path.normalize(entry)),
		)
	}
}

/** Bounded output and cancellation kill Git, and settlement waits for the child to close. */
export function runWorkspaceGit(
	root: string,
	args: string[],
	signal: AbortSignal,
	input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	signal.throwIfAborted()
	return new Promise((resolve, reject) => {
		let inputError: Error | undefined
		const child = execFile(
			"git",
			args,
			{
				cwd: root,
				env: { ...process.env, LC_ALL: "C" },
				maxBuffer: 64 * 1024 * 1024,
				encoding: "utf8",
			},
			(error, stdout, stderr) => {
				signal.removeEventListener("abort", abort)
				if (signal.aborted) return reject(signal.reason)
				if (inputError) return reject(inputError)
				if (error && typeof error.code !== "number") return reject(error)
				resolve({ code: (error?.code as number) ?? 0, stdout, stderr })
			},
		)
		const abort = () => {
			child.kill("SIGKILL")
		}
		signal.addEventListener("abort", abort, { once: true })
		child.stdin!.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EPIPE") {
				inputError = error
				child.kill("SIGKILL")
			}
		})
		child.stdin!.end(input)
		if (signal.aborted) abort()
	})
}

export interface WorkspaceEntry {
	absolutePath: string
	relativePath: string
	dirent: Dirent
}

interface TraversalOptions {
	signal: AbortSignal
	/** Applied before yielding or descending; excludes must not hide ignore-policy loading. */
	excludes?: (entry: WorkspaceEntry) => boolean
	descend?: (entry: WorkspaceEntry) => boolean
	recursive?: boolean
	/** Recovery scans can deliberately include ignored paths. */
	gitVisibility?: boolean
	/** Explicit file-browser targets may open an ignored directory without inheriting its parent's exclusion. */
	allowIgnoredRoot?: boolean
}

interface IgnoreScope {
	directory: string
	rules: Ignore
}

/** Breadth-first, pruned traversal. No symlink descent, recursive glob discovery or detached timeout work. */
export async function* walkWorkspace(root: string, options: TraversalOptions): AsyncGenerator<WorkspaceEntry> {
	const { signal } = options
	const visibility =
		options.gitVisibility === false ? undefined : await WorkspaceGitVisibility.create(root, signal, options.allowIgnoredRoot)
	const queue: Array<{ directory: string; scopes: IgnoreScope[] }> = [{ directory: root, scopes: [] }]
	for (let index = 0; index < queue.length; index++) {
		signal.throwIfAborted()
		const { directory, scopes: inheritedScopes } = queue[index]
		const scopes = [...inheritedScopes]
		if (visibility && !visibility.isGitWorkspace) {
			try {
				const contents = await readFile(path.join(directory, ".gitignore"), { encoding: "utf8", signal })
				scopes.push({ directory, rules: ignore().add(contents) })
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
		}
		const directoryHandle = await opendir(directory)
		const batch: WorkspaceEntry[] = []
		const visibleBatch = async () => {
			const ignored = (await visibility?.ignoredPaths(batch.map((entry) => entry.relativePath))) ?? new Set<string>()
			return batch.filter((entry) => {
				if (ignored.has(entry.relativePath)) return false
				let excluded = false
				for (const scope of scopes) {
					const relative =
						path.relative(scope.directory, entry.absolutePath).split(path.sep).join("/") +
						(entry.dirent.isDirectory() ? "/" : "")
					const result = scope.rules.test(relative)
					if (result.ignored) excluded = true
					else if (result.unignored) excluded = false
				}
				return !excluded
			})
		}
		// for-await closes the directory even when the consumer stops at its result limit.
		for await (const dirent of directoryHandle) {
			signal.throwIfAborted()
			const absolutePath = path.join(directory, dirent.name)
			const entry = { absolutePath, relativePath: path.relative(root, absolutePath), dirent }
			if (options.excludes?.(entry)) continue
			batch.push(entry)
			if (batch.length < 256) continue
			for (const visible of await visibleBatch()) {
				signal.throwIfAborted()
				yield visible
				if (
					visible.dirent.isDirectory() &&
					!visibility?.submodules.has(visible.relativePath) &&
					options.recursive !== false &&
					options.descend?.(visible) !== false
				)
					queue.push({ directory: visible.absolutePath, scopes })
			}
			batch.length = 0
		}
		for (const visible of await visibleBatch()) {
			signal.throwIfAborted()
			yield visible
			if (
				visible.dirent.isDirectory() &&
				!visibility?.submodules.has(visible.relativePath) &&
				options.recursive !== false &&
				options.descend?.(visible) !== false
			)
				queue.push({ directory: visible.absolutePath, scopes })
		}
	}
}
