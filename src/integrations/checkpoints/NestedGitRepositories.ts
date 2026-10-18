import * as fs from "node:fs/promises"
import * as path from "node:path"
import ignore, { type Ignore } from "ignore"
import { walkWorkspace } from "@/utils/workspaceTraversal"

const DISABLED_SUFFIX = "_disabled"

/** Journal before renaming so recovery never depends on the current ignore rules. */
export class NestedGitRepositories {
	private static readonly workspaceTails = new Map<string, Promise<void>>()
	private releaseMutationLock: (() => void) | undefined
	private pending = new Set<string>()
	private readonly exclusions: Ignore

	public constructor(
		private readonly root: string,
		private readonly journalPath: string,
		excludedPatterns: readonly string[] = [],
	) {
		this.exclusions = ignore().add([...excludedPatterns])
	}

	public async recover(signal: AbortSignal): Promise<void> {
		const release = await this.acquireWorkspaceLock(signal)
		try {
			await this.readRecoveryJournal(signal)
			await this.restorePendingRepositories()
		} finally {
			release()
		}
	}

	private async readRecoveryJournal(signal: AbortSignal): Promise<void> {
		try {
			const entries: string[] = JSON.parse(await fs.readFile(this.journalPath, { encoding: "utf8", signal }))
			for (const entry of entries) {
				const relative = path.relative(this.root, path.resolve(this.root, entry))
				if (
					path.isAbsolute(relative) ||
					relative === ".." ||
					relative.startsWith(`..${path.sep}`) ||
					path.basename(relative) !== ".git"
				) {
					throw new Error(`Invalid nested Git recovery path: ${entry}`)
				}
				this.pending.add(relative)
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			// One-time migration: old releases had no journal. Recovery must include now-ignored repos.
			// This scan is bounded and awaited; expiry prevents checkpoint initialization, never detaches work.
			for await (const entry of walkWorkspace(this.root, {
				signal,
				gitVisibility: false,
				excludes: (entry) => entry.dirent.name === "node_modules" || entry.dirent.name === ".git",
				descend: (entry) => entry.dirent.name !== `.git${DISABLED_SUFFIX}`,
			})) {
				if (entry.dirent.isDirectory() && entry.dirent.name === `.git${DISABLED_SUFFIX}`) {
					this.pending.add(entry.relativePath.slice(0, -DISABLED_SUFFIX.length))
				}
			}
			await this.persistJournal()
		}
	}

	public async disable(signal: AbortSignal): Promise<void> {
		this.releaseMutationLock = await this.acquireWorkspaceLock()
		if (this.pending.size > 0) throw new Error("Nested Git recovery must complete before another checkpoint")
		const repositories: string[] = []
		for await (const entry of walkWorkspace(this.root, {
			signal,
			// Workspace-local Git excludes may hide repositories that shadow staging still includes.
			gitVisibility: false,
			excludes: (entry) =>
				entry.dirent.name === "node_modules" ||
				entry.dirent.name === ".git" ||
				entry.dirent.name === `.git${DISABLED_SUFFIX}` ||
				this.exclusions.ignores(entry.relativePath.split(path.sep).join("/") + (entry.dirent.isDirectory() ? "/" : "")),
		})) {
			if (!entry.dirent.isDirectory()) continue
			const gitPath = path.join(entry.absolutePath, ".git")
			try {
				if ((await fs.lstat(gitPath)).isDirectory()) repositories.push(path.relative(this.root, gitPath))
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
		}
		// Discovery completes before any mutation. A cancelled scan cannot strand a repository.
		for (const repository of repositories) this.pending.add(repository)
		await this.persistJournal()
		for (const repository of repositories) {
			signal.throwIfAborted()
			const source = path.join(this.root, repository)
			await this.requireMissingPath(source + DISABLED_SUFFIX)
			await fs.rename(source, source + DISABLED_SUFFIX)
		}
	}

	public async restore(): Promise<void> {
		const release = this.releaseMutationLock ?? (await this.acquireWorkspaceLock())
		try {
			await this.restorePendingRepositories()
		} finally {
			this.releaseMutationLock = undefined
			release()
		}
	}

	private async restorePendingRepositories(): Promise<void> {
		const failures: unknown[] = []
		for (const repository of this.pending) {
			const target = path.join(this.root, repository)
			try {
				try {
					await fs.lstat(target + DISABLED_SUFFIX)
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
					// The journal is written before rename, so an intact original is already recovered.
					await fs.lstat(target)
					this.pending.delete(repository)
					continue
				}
				await this.requireMissingPath(target)
				await fs.rename(target + DISABLED_SUFFIX, target)
				this.pending.delete(repository)
			} catch (error) {
				failures.push(error)
			}
		}
		await this.persistJournal()
		if (failures.length)
			throw new AggregateError(failures, "Unable to restore nested Git repositories; recovery journal retained")
	}

	private async requireMissingPath(filePath: string): Promise<void> {
		try {
			await fs.lstat(filePath)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return
			throw error
		}
		throw new Error(`Refusing to overwrite nested Git metadata: ${filePath}`)
	}

	private async acquireWorkspaceLock(signal?: AbortSignal): Promise<() => void> {
		signal?.throwIfAborted()
		const previous = NestedGitRepositories.workspaceTails.get(this.root) ?? Promise.resolve()
		let release!: () => void
		const pending = new Promise<void>((resolve) => {
			release = resolve
		})
		// A cancelled waiter releases its slot, but later waiters must still await the current owner.
		const tail = previous.then(() => pending)
		NestedGitRepositories.workspaceTails.set(this.root, tail)
		void tail.then(() => {
			if (NestedGitRepositories.workspaceTails.get(this.root) === tail)
				NestedGitRepositories.workspaceTails.delete(this.root)
		})
		try {
			await new Promise<void>((resolve, reject) => {
				const abort = () => reject(signal?.reason)
				signal?.addEventListener("abort", abort, { once: true })
				void previous.then(() => {
					signal?.removeEventListener("abort", abort)
					resolve()
				})
			})
			signal?.throwIfAborted()
			return release
		} catch (error) {
			release()
			throw error
		}
	}

	private async persistJournal(): Promise<void> {
		const temporaryPath = `${this.journalPath}.tmp`
		await fs.writeFile(temporaryPath, JSON.stringify([...this.pending]))
		await fs.rename(temporaryPath, this.journalPath)
	}
}
