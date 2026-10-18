import * as fs from "node:fs/promises"
import os from "node:os"
import * as path from "node:path"
import { DiracIgnorePolicy } from "@/shared/ignore/DiracIgnorePolicy"
import { runWorkspaceGit, walkWorkspace, WorkspaceGitVisibility } from "@/utils/workspaceTraversal"

const SUPPORTED_EXTENSIONS = new Set([
	"js",
	"jsx",
	"ts",
	"tsx",
	"py",
	"rs",
	"go",
	"c",
	"h",
	"cpp",
	"hpp",
	"cs",
	"rb",
	"java",
	"php",
	"swift",
	"kt",
])

const EXCLUDED_DIRECTORY_NAMES = new Set([
	".dirac-cache",
	".dirac-symbol-index",
	".git",
	".hg",
	".svn",
	".cache",
	".mypy_cache",
	".next",
	".nox",
	".nuxt",
	".nyc_output",
	".parcel-cache",
	".pytest_cache",
	".ruff_cache",
	".tox",
	".venv",
	".yarn",
	"__generated__",
	"__pycache__",
	"bower_components",
	"build",
	"coverage",
	"coverage-unit",
	"dist",
	"dist-standalone",
	"env",
	"generated",
	"node_modules",
	"out",
	"target",
	"test-results",
	"tmp",
	"vendor",
	"venv",
])

const EXCLUDED_FILE_NAMES = new Set([
	"Cargo.lock",
	"Gemfile.lock",
	"composer.lock",
	"go.sum",
	"mix.lock",
	"package-lock.json",
	"pnpm-lock.yaml",
	"poetry.lock",
	"yarn.lock",
])

const GIT_TIMEOUT_MS = 120_000

interface GitResult {
	code: number
	stdout: Buffer
	stderr: string
}

export interface SymbolIndexControlPaths {
	isGitWorkspace: boolean
	gitDirectory: string | null
	externalControlPaths: Set<string>
}

export interface SymbolIndexEligibilityResult extends SymbolIndexControlPaths {
	paths: Set<string>
	directories: Set<string>
}

export class SymbolIndexEligibility {
	private readonly diracIgnorePolicy: DiracIgnorePolicy
	private gitWorkspace: boolean | null = null
	private gitDirectory: string | null = null
	private controlPaths = new Set<string>()

	public constructor(
		private readonly projectRoot: string,
		private readonly cancellationSignal = new AbortController().signal,
	) {
		this.diracIgnorePolicy = new DiracIgnorePolicy(projectRoot)
		this.controlPaths.add(path.join(projectRoot, ".diracignore"))
	}

	public admitsRelativePath(relativePath: string): boolean {
		const normalizedPath = path.normalize(relativePath)
		if (!this.isRelativePathWithinRoot(normalizedPath)) return false

		const segments = normalizedPath.split(path.sep)
		if (segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) return false
		if (EXCLUDED_FILE_NAMES.has(path.basename(normalizedPath))) return false
		if (!this.diracIgnorePolicy.allowsRelativePath(normalizedPath)) return false

		const extension = path.extname(normalizedPath).toLowerCase().slice(1)
		return SUPPORTED_EXTENSIONS.has(extension)
	}

	public admitsAbsolutePath(absolutePath: string): boolean {
		return this.admitsRelativePath(path.relative(this.projectRoot, absolutePath))
	}

	public excludesAbsolutePath(absolutePath: string): boolean {
		const relativePath = path.normalize(path.relative(this.projectRoot, absolutePath))
		if (!this.isRelativePathWithinRoot(relativePath)) return true
		if (relativePath.split(path.sep).some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) return true
		return !this.diracIgnorePolicy.allowsRelativePath(relativePath)
	}

	public isControlPath(absolutePath: string): boolean {
		const normalizedPath = path.normalize(absolutePath)
		const relativePath = path.normalize(path.relative(this.projectRoot, normalizedPath))
		if (this.isRelativePathWithinRoot(relativePath) && path.basename(relativePath) === ".gitignore") return true
		if (normalizedPath === path.join(this.projectRoot, ".git")) return true
		const rootGitRelativePath = path.normalize(path.relative(path.join(this.projectRoot, ".git"), normalizedPath))
		if (
			rootGitRelativePath === "config" ||
			rootGitRelativePath === "index" ||
			rootGitRelativePath === path.join("info", "exclude")
		)
			return true
		if (this.diracIgnorePolicy.isControlPath(normalizedPath)) return true
		return this.controlPaths.has(normalizedPath)
	}

	public async prepareControlPaths(): Promise<SymbolIndexControlPaths> {
		await this.diracIgnorePolicy.reload()
		this.controlPaths = new Set(this.diracIgnorePolicy.getControlPaths())
		this.gitWorkspace = await this.isGitWorkspace()

		if (!this.gitWorkspace) {
			this.gitDirectory = null
			return {
				isGitWorkspace: false,
				gitDirectory: null,
				externalControlPaths: this.getExternalControlPaths(),
			}
		}

		this.gitDirectory = await this.resolveGitDirectory()
		for (const controlPath of await this.resolveGitControlPaths()) this.controlPaths.add(controlPath)
		for (const controlPath of await this.resolveConfiguredGitControlPaths()) this.controlPaths.add(controlPath)
		return {
			isGitWorkspace: true,
			gitDirectory: this.gitDirectory,
			externalControlPaths: this.getExternalControlPaths(),
		}
	}

	public async enumerate(): Promise<SymbolIndexEligibilityResult> {
		const controlPaths = await this.prepareControlPaths()
		const directories = new Set([this.projectRoot])
		for await (const entry of walkWorkspace(this.projectRoot, {
			signal: AbortSignal.any([this.cancellationSignal, AbortSignal.timeout(30_000)]),
			gitVisibility: controlPaths.isGitWorkspace,
			excludes: (entry) => this.excludesAbsolutePath(entry.absolutePath),
		})) {
			if (entry.dirent.isDirectory()) directories.add(entry.absolutePath)
		}
		return {
			...controlPaths,
			directories,
			paths: controlPaths.isGitWorkspace ? await this.enumerateGitPaths() : await this.enumerateNonGitPaths(),
		}
	}

	public async isGitWorkspace(): Promise<boolean> {
		const gitStatus = await this.runGit(["rev-parse", "--is-inside-work-tree"])
		if (gitStatus.code === 0) return gitStatus.stdout.toString("utf8").trim() === "true"
		if (gitStatus.stderr.includes("not a git repository")) return false
		throw new Error(`Unable to determine Git workspace eligibility: ${gitStatus.stderr.trim()}`)
	}

	public async filterDirectoryPaths(absolutePaths: Iterable<string>): Promise<Set<string>> {
		const paths = [...absolutePaths].filter((absolutePath) => !this.excludesAbsolutePath(absolutePath))
		if (!paths.length) return new Set()
		const visibility = await WorkspaceGitVisibility.create(
			this.projectRoot,
			AbortSignal.any([this.cancellationSignal, AbortSignal.timeout(10_000)]),
		)
		const ignored = await visibility.ignoredPaths(paths.map((absolutePath) => path.relative(this.projectRoot, absolutePath)))
		return new Set(paths.filter((absolutePath) => !ignored.has(path.relative(this.projectRoot, absolutePath))))
	}

	public async filterAbsolutePaths(absolutePaths: Iterable<string>): Promise<Set<string>> {
		const candidates = new Map<string, string>()
		for (const absolutePath of absolutePaths) {
			const relativePath = path.normalize(path.relative(this.projectRoot, absolutePath))
			if (this.admitsRelativePath(relativePath)) candidates.set(relativePath, absolutePath)
		}
		if (candidates.size === 0) return new Set()

		const isGitWorkspace = this.gitWorkspace ?? (await this.isGitWorkspace())
		if (!isGitWorkspace) return new Set(candidates.values())

		const input = `${[...candidates.keys()].map((relativePath) => relativePath.split(path.sep).join("/")).join("\0")}\0`
		const result = await this.runGit(["check-ignore", "-z", "--stdin"], input)
		if (result.code !== 0 && result.code !== 1) {
			throw new Error(`Git eligibility check failed: ${result.stderr.trim()}`)
		}

		const ignoredPaths = new Set(
			result.stdout
				.toString("utf8")
				.split("\0")
				.filter(Boolean)
				.map((relativePath) => path.normalize(relativePath)),
		)
		return new Set(
			[...candidates].filter(([relativePath]) => !ignoredPaths.has(relativePath)).map(([, absolutePath]) => absolutePath),
		)
	}

	private async enumerateGitPaths(): Promise<Set<string>> {
		const result = await this.runGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
		if (result.code !== 0) throw new Error(`Git eligibility enumeration failed: ${result.stderr.trim()}`)

		const eligiblePaths = new Set<string>()
		for (const gitPath of result.stdout.toString("utf8").split("\0")) {
			if (!gitPath) continue
			const relativePath = path.normalize(gitPath)
			if (this.admitsRelativePath(relativePath)) eligiblePaths.add(relativePath)
		}
		return eligiblePaths
	}

	private async resolveGitDirectory(): Promise<string> {
		const result = await this.runGit(["rev-parse", "--absolute-git-dir"])
		if (result.code !== 0) throw new Error(`Unable to resolve Git control directory: ${result.stderr.trim()}`)
		return path.normalize(result.stdout.toString("utf8").trim())
	}

	private async resolveGitControlPaths(): Promise<Set<string>> {
		const result = await this.runGit([
			"rev-parse",
			"--path-format=absolute",
			"--git-path",
			"config",
			"--git-path",
			"index",
			"--git-path",
			"info/exclude",
			"--git-path",
			"config.worktree",
		])
		if (result.code !== 0) throw new Error(`Unable to resolve Git control paths: ${result.stderr.trim()}`)
		return new Set(
			result.stdout
				.toString("utf8")
				.split(/\r?\n/)
				.filter(Boolean)
				.map((controlPath) => path.normalize(controlPath)),
		)
	}

	private async resolveConfiguredGitControlPaths(): Promise<Set<string>> {
		const controls = await this.resolveStandardGlobalGitControlPaths()
		const result = await this.runGit(["config", "--show-origin", "--path", "--get", "core.excludesFile"])
		if (result.code === 1) return controls
		if (result.code !== 0) throw new Error(`Unable to resolve Git excludes controls: ${result.stderr.trim()}`)

		const output = result.stdout.toString("utf8").trim()
		const separatorIndex = output.indexOf("\t")
		const origin = separatorIndex >= 0 ? output.slice(0, separatorIndex) : ""
		const excludesFile = separatorIndex >= 0 ? output.slice(separatorIndex + 1) : output
		if (origin.startsWith("file:")) controls.add(this.resolveControlPath(origin.slice("file:".length)))
		if (excludesFile) controls.add(this.resolveControlPath(excludesFile))
		return controls
	}

	private async resolveStandardGlobalGitControlPaths(): Promise<Set<string>> {
		const homeDirectory = os.homedir()
		const xdgConfigDirectory = process.env.XDG_CONFIG_HOME || path.join(homeDirectory, ".config")
		const candidates = process.env.GIT_CONFIG_GLOBAL
			? [this.resolveControlPath(process.env.GIT_CONFIG_GLOBAL)]
			: [path.join(homeDirectory, ".gitconfig"), path.join(xdgConfigDirectory, "git", "config")]
		candidates.push(path.join(xdgConfigDirectory, "git", "ignore"))
		if (process.env.GIT_CONFIG_SYSTEM) candidates.push(this.resolveControlPath(process.env.GIT_CONFIG_SYSTEM))

		const controls = new Set<string>()
		for (const candidate of candidates) {
			try {
				await fs.access(path.dirname(candidate))
				controls.add(path.normalize(candidate))
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
		}
		return controls
	}

	private async enumerateNonGitPaths(): Promise<Set<string>> {
		const eligiblePaths = new Set<string>()
		const directories = [this.projectRoot]

		while (directories.length > 0) {
			this.cancellationSignal.throwIfAborted()
			const directory = directories.pop()!
			const entries = await fs.readdir(directory, { withFileTypes: true })
			for (const entry of entries) {
				const absolutePath = path.join(directory, entry.name)
				const relativePath = path.normalize(path.relative(this.projectRoot, absolutePath))
				if (entry.isDirectory()) {
					if (!this.excludesAbsolutePath(absolutePath)) directories.push(absolutePath)
					continue
				}
				if (entry.isFile() && this.admitsRelativePath(relativePath)) eligiblePaths.add(relativePath)
			}
		}
		return eligiblePaths
	}

	private getExternalControlPaths(): Set<string> {
		// Workspace watching is pruned; Git metadata must have explicit non-recursive control watches too.
		return new Set(this.controlPaths)
	}

	private isInsideProjectRoot(absolutePath: string): boolean {
		const relativePath = path.normalize(path.relative(this.projectRoot, absolutePath))
		return relativePath === "." || this.isRelativePathWithinRoot(relativePath)
	}

	private isRelativePathWithinRoot(relativePath: string): boolean {
		return (
			Boolean(relativePath) &&
			relativePath !== ".." &&
			!relativePath.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relativePath)
		)
	}

	private resolveControlPath(controlPath: string): string {
		return path.normalize(path.isAbsolute(controlPath) ? controlPath : path.resolve(this.projectRoot, controlPath))
	}

	private async runGit(args: string[], input?: string): Promise<GitResult> {
		const result = await runWorkspaceGit(
			this.projectRoot,
			args,
			AbortSignal.any([this.cancellationSignal, AbortSignal.timeout(GIT_TIMEOUT_MS)]),
			input,
		)
		return { ...result, stdout: Buffer.from(result.stdout) }
	}
}
