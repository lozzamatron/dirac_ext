import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, it } from "mocha"
import "should"
import sinon from "sinon"
import { SymbolIndexEligibility } from "../SymbolIndexEligibility"

const execFileAsync = promisify(execFile)

describe("SymbolIndexEligibility", () => {
	let projectRoot: string
	const externalFiles: string[] = []

	beforeEach(async () => {
		projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-symbol-eligibility-"))
		await execFileAsync("git", ["init", "-q"], { cwd: projectRoot })
		await execFileAsync("git", ["config", "user.email", "symbol-index@example.com"], { cwd: projectRoot })
		await execFileAsync("git", ["config", "user.name", "Symbol Index Test"], { cwd: projectRoot })
	})

	afterEach(async () => {
		sinon.restore()
		await fs.rm(projectRoot, { recursive: true, force: true })
		await Promise.all(externalFiles.splice(0).map((filePath) => fs.rm(filePath, { force: true })))
	})

	it("uses Git ignore sources, negations, tracked-file rules, and standard generated exclusions", async () => {
		await fs.mkdir(path.join(projectRoot, "nested"), { recursive: true })
		await fs.mkdir(path.join(projectRoot, "generated"), { recursive: true })
		await fs.writeFile(path.join(projectRoot, ".gitignore"), "ignored.ts\ntracked.ts\n")
		await fs.writeFile(path.join(projectRoot, "nested", ".gitignore"), "*.ts\n!keep.ts\n")
		await fs.writeFile(path.join(projectRoot, "ignored.ts"), "export const ignored = 1\n")
		await fs.writeFile(path.join(projectRoot, "tracked.ts"), "export const tracked = 1\n")
		await fs.writeFile(path.join(projectRoot, "nested", "drop.ts"), "export const drop = 1\n")
		await fs.writeFile(path.join(projectRoot, "nested", "keep.ts"), "export const keep = 1\n")
		await fs.writeFile(path.join(projectRoot, "generated", "tracked.ts"), "export const generated = 1\n")
		await execFileAsync("git", ["add", "-f", "tracked.ts", "generated/tracked.ts"], { cwd: projectRoot })

		const result = await new SymbolIndexEligibility(projectRoot).enumerate()

		result.isGitWorkspace.should.be.true()
		result.paths.has("tracked.ts").should.be.true()
		result.paths.has(path.join("nested", "keep.ts")).should.be.true()
		result.paths.has("ignored.ts").should.be.false()
		result.paths.has(path.join("nested", "drop.ts")).should.be.false()
		result.paths.has(path.join("generated", "tracked.ts")).should.be.false()
	})

	it("applies .diracignore patterns and includes to full enumeration", async () => {
		await fs.writeFile(path.join(projectRoot, "included.ignore"), "included.ts\n")
		await fs.writeFile(path.join(projectRoot, ".diracignore"), "ignored.ts\n!include included.ignore\n")
		await fs.writeFile(path.join(projectRoot, "ignored.ts"), "export const ignored = 1\n")
		await fs.writeFile(path.join(projectRoot, "included.ts"), "export const included = 1\n")
		await fs.writeFile(path.join(projectRoot, "allowed.ts"), "export const allowed = 1\n")

		const eligibility = new SymbolIndexEligibility(projectRoot)
		const result = await eligibility.enumerate()

		result.paths.has("allowed.ts").should.be.true()
		result.paths.has("ignored.ts").should.be.false()
		result.paths.has("included.ts").should.be.false()
		eligibility.isControlPath(path.join(projectRoot, ".diracignore")).should.be.true()
		eligibility.isControlPath(path.join(projectRoot, "included.ignore")).should.be.true()
	})

	it("honors info excludes and configured global excludes", async () => {
		const globalExclude = path.join(os.tmpdir(), `dirac-global-ignore-${Date.now()}-${Math.random()}`)
		externalFiles.push(globalExclude)
		await fs.writeFile(globalExclude, "global.ts\n")
		await execFileAsync("git", ["config", "core.excludesFile", globalExclude], { cwd: projectRoot })
		await fs.writeFile(path.join(projectRoot, ".git", "info", "exclude"), "info.ts\n")
		await fs.writeFile(path.join(projectRoot, "info.ts"), "export const info = 1\n")
		await fs.writeFile(path.join(projectRoot, "global.ts"), "export const global = 1\n")
		await fs.writeFile(path.join(projectRoot, "allowed.ts"), "export const allowed = 1\n")

		const result = await new SymbolIndexEligibility(projectRoot).enumerate()

		result.paths.has("allowed.ts").should.be.true()
		result.paths.has("info.ts").should.be.false()
		result.paths.has("global.ts").should.be.false()
		result.externalControlPaths.has(globalExclude).should.be.true()
	})

	it("batch-checks live paths while retaining tracked files matched by ignore rules", async () => {
		await fs.writeFile(path.join(projectRoot, ".gitignore"), "ignored.ts\ntracked.ts\n")
		for (const fileName of ["allowed.ts", "ignored.ts", "tracked.ts"]) {
			await fs.writeFile(path.join(projectRoot, fileName), `export const ${fileName.replace(".ts", "")} = 1\n`)
		}
		await execFileAsync("git", ["add", "-f", "tracked.ts"], { cwd: projectRoot })
		const eligibility = new SymbolIndexEligibility(projectRoot)
		await eligibility.enumerate()

		const filtered = await eligibility.filterAbsolutePaths(
			["allowed.ts", "ignored.ts", "tracked.ts"].map((fileName) => path.join(projectRoot, fileName)),
		)

		filtered.has(path.join(projectRoot, "allowed.ts")).should.be.true()
		filtered.has(path.join(projectRoot, "tracked.ts")).should.be.true()
		filtered.has(path.join(projectRoot, "ignored.ts")).should.be.false()
	})

	it("reflects newly ignored and newly unignored files on the next enumeration", async () => {
		await fs.writeFile(path.join(projectRoot, "dynamic.ts"), "export const dynamic = 1\n")
		const eligibility = new SymbolIndexEligibility(projectRoot)
		;(await eligibility.enumerate()).paths.has("dynamic.ts").should.be.true()

		await fs.writeFile(path.join(projectRoot, ".gitignore"), "dynamic.ts\n")
		;(await eligibility.enumerate()).paths.has("dynamic.ts").should.be.false()

		await fs.writeFile(path.join(projectRoot, ".gitignore"), "")
		;(await eligibility.enumerate()).paths.has("dynamic.ts").should.be.true()
	})

	it("keeps watch coverage for non-Git sources matched by a local .gitignore", async () => {
		await fs.rm(path.join(projectRoot, ".git"), { recursive: true })
		await fs.mkdir(path.join(projectRoot, ".hg"))
		await fs.mkdir(path.join(projectRoot, "sources"))
		await fs.writeFile(path.join(projectRoot, ".gitignore"), "sources/\n")
		await fs.writeFile(path.join(projectRoot, "sources", "main.ts"), "export const value = 1\n")

		const result = await new SymbolIndexEligibility(projectRoot).enumerate()

		result.isGitWorkspace.should.be.false()
		result.paths.has(path.join("sources", "main.ts")).should.be.true()
		result.directories.has(path.join(projectRoot, "sources")).should.be.true()
	})

	it("fails closed when authoritative Git eligibility enumeration fails", async () => {
		const eligibility = new SymbolIndexEligibility(projectRoot)
		const runGit = sinon.stub(eligibility as any, "runGit").callsFake(async (...callArguments: unknown[]) => {
			const args = callArguments[0] as string[]
			if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
				return { code: 0, stdout: Buffer.from("true\n"), stderr: "" }
			}
			if (args.includes("--git-path")) {
				return {
					code: 0,
					stdout: Buffer.from(
						["config", "index", path.join("info", "exclude"), "config.worktree"]
							.map((controlPath) => path.join(projectRoot, ".git", controlPath))
							.join("\n"),
					),
					stderr: "",
				}
			}
			if (args[0] === "rev-parse")
				return { code: 0, stdout: Buffer.from(`${path.join(projectRoot, ".git")}\n`), stderr: "" }
			if (args[0] === "config") return { code: 1, stdout: Buffer.alloc(0), stderr: "" }
			return { code: 1, stdout: Buffer.alloc(0), stderr: "injected failure" }
		})

		let error: Error | null = null
		try {
			await eligibility.enumerate()
		} catch (caught) {
			error = caught as Error
		}

		error?.message.should.match(/Git eligibility enumeration failed/)
		runGit.callCount.should.equal(5)
	})
})
