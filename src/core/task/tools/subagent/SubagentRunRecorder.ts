import fs from "node:fs/promises"
import * as path from "node:path"
import { ensureTaskDirectoryExists } from "@core/storage/directoryEnsurers"
import type { AgentMapUsage } from "@shared/agentMap"
import { SubagentExecutionStatus } from "@shared/ExtensionMessage"
import type { SubagentIdentity } from "@shared/subagents"
import { Logger } from "@shared/services/Logger"
import { SUBAGENT_RUNS_FILE, upsertSubagentRun } from "./SubagentRunIndex"

export type SubagentRunPhase =
	| "starting"
	| "building_initial_context"
	| "building_workspace_metadata"
	| "awaiting_first_provider_chunk"
	| "streaming_provider_response"
	| "executing_tool"
	| "refreshing_context"
	| "wrapping_up"
	| "cancelling"
	| "completed"
	| "failed"
	| "cancelled"

export interface SubagentRunRecorderOptions {
	taskId: string
	agent: SubagentIdentity
	taskTitle: string
	prompt: string
	timeoutSeconds: number
	includeHistory: boolean
	providerId?: string
	modelId?: string
	taskDirectory?: string
	runId?: string
}

export interface SubagentRunArtifactPaths {
	runId: string
	runDirectory: string
	transcriptPath: string
	diagnosticsPath: string
	indexPath: string
	runsPath: string
}

export interface SubagentTranscriptEvent {
	type: "assistant_text" | "tool_call" | "tool_result" | "usage" | "progress" | "terminal"
	details: Record<string, unknown>
}

export interface SubagentDiagnosticEvent {
	type: "phase_entered" | "phase_completed" | "heartbeat" | "liveness_warning" | "retry" | "abort_requested" | "terminal"
	phase: SubagentRunPhase
	details?: Record<string, unknown>
}

const SECRET_KEY_PATTERN = /(?:api[-_]?key|authorization|cookie|password|secret|token|credential)/i
const SECRET_VALUE_PATTERNS = [/(Bearer\s+)[^\s"']+/gi, /\bsk-[A-Za-z0-9_-]{16,}\b/g]

/**
 * Appends complete subagent audit content and compact runtime diagnostics without reading or rewriting task state.
 * Each recorder owns one run directory; the task index uses a process-local append queue to keep concurrent dispatches ordered.
 */
export class SubagentRunRecorder {
	private static readonly appendTails = new Map<string, Promise<void>>()
	private transcriptSequence = 0
	private diagnosticSequence = 0
	// Captured once at construction: the terminal record needs the run's start
	// time, and re-reading the clock there would measure the wrong thing.
	private readonly startedAt = Date.now()

	private constructor(
		private readonly options: SubagentRunRecorderOptions,
		private readonly paths: SubagentRunArtifactPaths,
	) { }

	static async create(options: SubagentRunRecorderOptions): Promise<SubagentRunRecorder> {
		const taskDirectory = options.taskDirectory ?? (await ensureTaskDirectoryExists(options.taskId))
		const runId = options.runId ?? createRunId(options.agent)
		const runDirectory = path.join(taskDirectory, "subagents", runId)
		const paths = {
			runId,
			runDirectory,
			transcriptPath: path.join(runDirectory, "transcript.md"),
			diagnosticsPath: path.join(runDirectory, "diagnostics.md"),
			indexPath: path.join(taskDirectory, "subagents", "index.md"),
			runsPath: path.join(taskDirectory, "subagents", SUBAGENT_RUNS_FILE),
		}
		const recorder = new SubagentRunRecorder(options, paths)
		await recorder.initialize()
		return recorder
	}

	getPaths(): SubagentRunArtifactPaths {
		return { ...this.paths }
	}

	async recordTranscript(event: SubagentTranscriptEvent): Promise<void> {
		const sequence = ++this.transcriptSequence
		await this.append(this.paths.transcriptPath, formatRecord(sequence, event.type, event.details))
	}

	async recordDiagnostic(event: SubagentDiagnosticEvent): Promise<void> {
		const sequence = ++this.diagnosticSequence
		await this.append(this.paths.diagnosticsPath, formatRecord(sequence, event.type, {
			phase: event.phase,
			...event.details,
		}))
	}

	async recordTerminal(status: SubagentExecutionStatus, details: Record<string, unknown>): Promise<void> {
		const terminalDetails = { status, ...details }
		await Promise.all([
			this.recordTranscript({ type: "terminal", details: terminalDetails }),
			this.recordDiagnostic({ type: "terminal", phase: terminalPhase(status), details: terminalDetails }),
			this.append(this.paths.indexPath, formatIndexRecord(this.options, this.paths, terminalDetails)),
			upsertSubagentRun(this.paths.runsPath, this.options.taskId, {
				runId: this.paths.runId,
				status: terminalSidecarStatus(status),
				endedAt: Date.now(),
				usage: extractUsage(details),
				error: typeof details.error === "string" ? details.error : undefined,
			}),
		])
	}

	async flush(): Promise<void> {
		await Promise.all(
			[this.paths.transcriptPath, this.paths.diagnosticsPath, this.paths.indexPath].map(
				(filePath) => SubagentRunRecorder.appendTails.get(filePath) ?? Promise.resolve(),
			),
		)
	}

	private async initialize(): Promise<void> {
		await fs.mkdir(this.paths.runDirectory, { recursive: true })
		await Promise.all([
			fs.writeFile(this.paths.transcriptPath, formatTranscriptHeader(this.options, this.paths), { encoding: "utf8", flag: "wx" }),
			fs.writeFile(this.paths.diagnosticsPath, formatDiagnosticsHeader(this.options, this.paths), { encoding: "utf8", flag: "wx" }),
			this.append(this.paths.indexPath, formatIndexRecord(this.options, this.paths, { status: "started" })),
			upsertSubagentRun(this.paths.runsPath, this.options.taskId, {
				runId: this.paths.runId,
				agentId: this.options.agent.id,
				agentName: this.options.agent.name,
				taskTitle: this.options.taskTitle,
				prompt: this.options.prompt,
				status: "running",
				startedAt: this.startedAt,
				modelId: this.options.modelId,
				providerId: this.options.providerId,
				transcriptPath: relativePath(this.paths.runsPath, this.paths.transcriptPath),
			}),
		])
	}

	private async append(filePath: string, content: string): Promise<void> {
		const previous = SubagentRunRecorder.appendTails.get(filePath) ?? Promise.resolve()
		const operation = previous.then(() => fs.appendFile(filePath, content, "utf8"))
		const tail = operation.catch(() => undefined)
		SubagentRunRecorder.appendTails.set(filePath, tail)
		try {
			await operation
		} catch (error) {
			Logger.error(`[SubagentRunRecorder] Failed to append ${filePath}`, error)
			throw error
		} finally {
			if (SubagentRunRecorder.appendTails.get(filePath) === tail) {
				SubagentRunRecorder.appendTails.delete(filePath)
			}
		}
	}
}

function createRunId(agent: SubagentIdentity): string {
	return `${Date.now()}-${agent.id}-${slugify(agent.name)}-${Math.random().toString(36).slice(2, 8)}`
}

function slugify(value: string): string {
	const slug = value
		.normalize("NFKD")
		.replace(/[^\w]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase()
	return slug || "subagent"
}

function terminalPhase(status: SubagentExecutionStatus): SubagentRunPhase {
	if (status === SubagentExecutionStatus.COMPLETED) return "completed"
	if (status === SubagentExecutionStatus.FAILED) return "failed"
	return "cancelled"
}

// A terminal record that is not terminal is a bug elsewhere; guessing
// "completed" would put a lie on disk, so anything unknown stays "running".
function terminalSidecarStatus(status: SubagentExecutionStatus): "running" | "completed" | "failed" | "cancelled" {
	if (status === SubagentExecutionStatus.COMPLETED) return "completed"
	if (status === SubagentExecutionStatus.FAILED) return "failed"
	if (status === SubagentExecutionStatus.CANCELLED) return "cancelled"
	return "running"
}

// Reads usage out of the untyped terminal details defensively. Returns undefined
// when there are no stats at all — a run with no measured usage must have no
// usage field rather than a row of zeroes that reads as a real measurement.
function extractUsage(details: Record<string, unknown>): AgentMapUsage | undefined {
	const stats = details.stats
	if (typeof stats !== "object" || stats === null || Array.isArray(stats)) {
		return undefined
	}
	const record = stats as Record<string, unknown>
	const inputTokens = readFiniteNumber(record.inputTokens)
	const outputTokens = readFiniteNumber(record.outputTokens)
	const cacheReadTokens = readFiniteNumber(record.cacheReadTokens)
	const cacheWriteTokens = readFiniteNumber(record.cacheWriteTokens)
	if (
		inputTokens === undefined ||
		outputTokens === undefined ||
		cacheReadTokens === undefined ||
		cacheWriteTokens === undefined
	) {
		return undefined
	}
	const totalCost = readFiniteNumber(record.totalCost)
	return totalCost === undefined
		? { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
		: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalCost }
}

function readFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function formatTranscriptHeader(options: SubagentRunRecorderOptions, paths: SubagentRunArtifactPaths): string {
	return [
		"# Subagent transcript",
		"",
		formatMetadata({
			taskId: options.taskId,
			runId: paths.runId,
			agent: options.agent,
			taskTitle: options.taskTitle,
			prompt: options.prompt,
			timeoutSeconds: options.timeoutSeconds,
			includeHistory: options.includeHistory,
			providerId: options.providerId,
			modelId: options.modelId,
		}),
		"",
	].join("\n")
}

function formatDiagnosticsHeader(options: SubagentRunRecorderOptions, paths: SubagentRunArtifactPaths): string {
	return [
		"# Subagent diagnostics",
		"",
		formatMetadata({
			taskId: options.taskId,
			runId: paths.runId,
			agent: options.agent,
			taskTitle: options.taskTitle,
			createdAt: new Date().toISOString(),
		}),
		"",
	].join("\n")
}

function formatIndexRecord(
	options: SubagentRunRecorderOptions,
	paths: SubagentRunArtifactPaths,
	details: Record<string, unknown>,
): string {
	return formatRecord(0, "subagent_run", {
		taskId: options.taskId,
		runId: paths.runId,
		agent: options.agent,
		taskTitle: options.taskTitle,
		transcript: relativePath(paths.indexPath, paths.transcriptPath),
		diagnostics: relativePath(paths.indexPath, paths.diagnosticsPath),
		...details,
	})
}

function relativePath(fromFile: string, toFile: string): string {
	return path.relative(path.dirname(fromFile), toFile)
}

function formatRecord(sequence: number, type: string, details: Record<string, unknown>): string {
	const timestamp = new Date().toISOString()
	return [`## ${timestamp} · event ${sequence} · ${type}`, "", formatMetadata(details), ""].join("\n")
}

function formatMetadata(value: unknown): string {
	const json = JSON.stringify(redact(value), jsonReplacer, 2)
	const fence = chooseFence(json)
	return `${fence}json\n${json}\n${fence}`
}

function chooseFence(content: string): string {
	const matches = content.match(/`+/g) ?? []
	const width = matches.reduce((largest, match) => Math.max(largest, match.length), 2) + 1
	return "`".repeat(width)
}

function jsonReplacer(_key: string, value: unknown): unknown {
	if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack }
	if (typeof value === "bigint") return value.toString()
	return value
}

function redact(value: unknown, key?: string, seen = new WeakSet<object>()): unknown {
	if (key && SECRET_KEY_PATTERN.test(key)) return "[REDACTED]"
	if (typeof value === "string") return redactString(value)
	if (value instanceof Error) {
		return {
			name: value.name,
			message: redactString(value.message),
			stack: value.stack ? redactString(value.stack) : undefined,
		}
	}
	if (!value || typeof value !== "object") return value
	if (seen.has(value)) return "[CIRCULAR]"
	seen.add(value)
	if (Array.isArray(value)) return value.map((entry) => redact(entry, undefined, seen))
	return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey, seen)]))
}

function redactString(value: string): string {
	return SECRET_VALUE_PATTERNS.reduce((redacted, pattern) => redacted.replace(pattern, "$1[REDACTED]"), value)
}
