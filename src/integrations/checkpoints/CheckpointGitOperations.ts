import { fileExistsAtPath } from "@utils/fs"
import { retryWithBackoff } from "@utils/retry"
import * as path from "path"
import simpleGit, { type SimpleGit } from "simple-git"
import { telemetryService } from "@/services/telemetry"
import { NestedGitRepositories } from "./NestedGitRepositories"
import { Logger } from "@/shared/services/Logger"
import { getDefaultExclusions, getLfsPatterns, writeExcludesFile } from "./CheckpointExclusions"

interface CheckpointAddResult {
	success: boolean
}

/**
 * GitOperations Class
 *
 * Handles git-specific operations for Dirac's Checkpoints system.
 *
 * Key responsibilities:
 * - Git repository initialization and configuration
 * - Git settings management (user, LFS, etc.)
 * - Worktree configuration and management
 * - Managing nested git repositories during checkpoint operations
 * - File staging and checkpoint creation
 * - Shadow git repository maintenance and cleanup
 */
export class GitOperations {
	private cwd: string
	private nestedRepositories!: NestedGitRepositories

	/**
	 * Creates a new GitOperations instance.
	 *
	 * @param cwd - The current working directory for git operations
	 */
	constructor(cwd: string) {
		this.cwd = cwd
	}

	/**
	 * Initializes or verifies a shadow Git repository for checkpoint tracking.
	 * Creates a new repository if one doesn't exist, or verifies the worktree
	 * configuration if it does.
	 *
	 * Key operations:
	 * - Creates/verifies shadow git repository
	 * - Configures git settings (user, LFS, etc.)
	 * - Sets up worktree to point to workspace
	 *
	 * @param gitPath - Path to the .git directory
	 * @param cwd - The current working directory for git operations
	 * @returns Promise<string> Path to the initialized .git directory
	 * @throws Error if:
	 * - Worktree verification fails for existing repository
	 * - Git initialization or configuration fails
	 * - Unable to create initial commit
	 * - LFS pattern setup fails
	 */
	public async initShadowGit(
		gitPath: string,
		cwd: string,
		taskId: string,
		signal = AbortSignal.timeout(15_000),
	): Promise<string> {
		Logger.info(`Initializing shadow git`)
		this.nestedRepositories = new NestedGitRepositories(
			cwd,
			path.join(path.dirname(gitPath), "nested-git-recovery.json"),
			getDefaultExclusions(),
		)
		await this.nestedRepositories.recover(signal)
		signal.throwIfAborted()

		// If repo exists, just verify worktree
		if (await fileExistsAtPath(gitPath)) {
			const git = simpleGit(path.dirname(gitPath), { abort: signal })
			const worktree = await git.getConfig("core.worktree")
			if (worktree.value !== cwd) {
				throw new Error("Checkpoints can only be used in the original workspace: " + worktree.value)
			}
			Logger.warn(`Using existing shadow git at ${gitPath}`)

			// shadow git repo already exists, but update the excludes just in case
			await writeExcludesFile(gitPath, await getLfsPatterns(this.cwd))

			return gitPath
		}

		// Initialize new repo
		const startTime = performance.now()
		const checkpointsDir = path.dirname(gitPath)
		Logger.warn(`Creating new shadow git in ${checkpointsDir}`)

		const git = simpleGit(checkpointsDir, { abort: signal })
		await git.init()

		// Configure repo with git settings
		await git.addConfig("core.worktree", cwd)
		await git.addConfig("commit.gpgSign", "false")
		await git.addConfig("user.name", "Dirac Checkpoint")
		await git.addConfig("user.email", "checkpoint@dirac.run")

		// Set up LFS patterns
		const lfsPatterns = await getLfsPatterns(cwd)
		await writeExcludesFile(gitPath, lfsPatterns)

		const addFilesResult = await this.addCheckpointFiles(git, signal)
		if (!addFilesResult.success) {
			Logger.error("Failed to add at least one file(s) to checkpoints shadow git")
			throw new Error("Failed to add at least one file(s) to checkpoints shadow git")
		}

		// Initial commit only on first repo creation
		await git.commit("initial commit", { "--allow-empty": null, "--no-verify": null })

		const durationMs = Math.round(performance.now() - startTime)
		telemetryService.captureCheckpointUsage(taskId, "shadow_git_initialized", durationMs)

		Logger.warn(`Shadow git initialization completed`)

		return gitPath
	}

	/**
	 * Retrieves the worktree path from the shadow git configuration.
	 * The worktree path indicates where the shadow git repository is tracking files,
	 * which should match the current workspace directory.
	 *
	 * @param gitPath - Path to the .git directory
	 * @returns Promise<string | undefined> The worktree path or undefined if not found
	 * @throws Error if unable to get worktree path
	 */
	public async getShadowGitConfigWorkTree(gitPath: string): Promise<string | undefined> {
		try {
			const git = simpleGit(path.dirname(gitPath))
			const worktree = await git.getConfig("core.worktree")
			return worktree.value || undefined
		} catch (error) {
			Logger.error("Failed to get shadow git config worktree:", error)
			return undefined
		}
	}

	/** Restore is deliberately not cancelled: every recorded rename must be undone before returning. */
	public async renameNestedGitRepos(disable: boolean, signal = AbortSignal.timeout(10_000)): Promise<void> {
		if (disable) await this.nestedRepositories.disable(signal)
		else await this.nestedRepositories.restore()
	}

	public async addCheckpointFiles(git: SimpleGit, signal = AbortSignal.timeout(10_000)): Promise<CheckpointAddResult> {
		const startTime = performance.now()
		try {
			// Update exclude patterns before each commit
			await this.renameNestedGitRepos(true, signal)
			Logger.info("Starting checkpoint add operation...")

			// Optimization: Use git status --porcelain to find changed files
			// This is much faster than git add . in large repositories
			const status = await git.status(["--porcelain", "--untracked-files=all"])
			const filesToStage = status.files.map((f) => f.path)

			if (filesToStage.length === 0) {
				Logger.debug("No files to stage for checkpoint")
				return { success: true }
			}

			// Attempt to add only changed files. Any files with permissions errors will not be added,
			// but the process will proceed and add the rest (--ignore-errors).
			try {
				// If there are many files, git add . might still be faster or safer due to command line length limits
				if (filesToStage.length > 100) {
					await git.add([".", "--ignore-errors"])
				} else {
					await git.add([...filesToStage, "--ignore-errors"])
				}

				const durationMs = Math.round(performance.now() - startTime)
				Logger.debug(`Checkpoint add operation completed in ${durationMs}ms for ${filesToStage.length} files`)
				return { success: true }
			} catch (_error) {
				// Fallback to git add . if targeted add fails
				try {
					await git.add([".", "--ignore-errors"])
					return { success: true }
				} catch (__error) {
					return { success: false }
				}
			}
		} catch (_error) {
			return { success: false }
		} finally {
			await retryWithBackoff(() => this.renameNestedGitRepos(false), {
				operationName: "CheckpointTracker re-enable nested git repos",
				maxAttempts: 3,
				baseDelayMs: 50,
				onRetry: (_error, attempt, maxAttempts, delayMs) => {
					Logger.warn(
						`CheckpointTracker re-enable nested git repos failed on attempt ${attempt}/${maxAttempts}. Retrying in ${delayMs}ms`,
					)
				},
			})
		}
	}
}

export const GIT_DISABLED_SUFFIX = "_disabled"
