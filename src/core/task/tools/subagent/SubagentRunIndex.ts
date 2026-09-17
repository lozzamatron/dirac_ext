// Machine-readable sidecar index of a task's subagent runs, stored beside the
// human-facing Markdown artifacts as `<taskDir>/subagents/runs.json`.
//
// The transcript/diagnostics/index Markdown files exist so a person can follow a
// run; Markdown is for humans and is not a data format. This file is the one the
// extension host reads back from disk — e.g. to rebuild an Agent Map for a
// conversation whose message cards are gone — so its shape is stable and
// versioned (SUBAGENT_RUNS_VERSION).
//
// Concurrency hazard: several subagents of one task run CONCURRENTLY and share a
// single runs.json. Two interleaved read-modify-write cycles would each read the
// same snapshot and the second write would erase the first run. Every upsert
// therefore chains onto a per-path tail promise (the same technique
// SubagentRunRecorder uses for appends), serializing the whole cycle, not just
// the write.

import fs from "node:fs/promises"
import * as path from "node:path"
import type { AgentMapUsage } from "@shared/agentMap"
import { Logger } from "@shared/services/Logger"

export const SUBAGENT_RUNS_FILE = "runs.json"
export const SUBAGENT_RUNS_VERSION = 1

export interface SubagentRunRecord {
	runId: string
	agentId: number
	agentName: string
	taskTitle?: string
	prompt?: string
	status: "running" | "completed" | "failed" | "cancelled"
	startedAt: number
	endedAt?: number
	modelId?: string
	providerId?: string
	usage?: AgentMapUsage
	transcriptPath?: string
	error?: string
}

export interface SubagentRunIndexFile {
	version: number
	taskId: string
	runs: SubagentRunRecord[]
}

// Module-level per-path tails: each upsert chains onto the previous one for the
// whole read-modify-write, so concurrent dispatches of one task can never
// interleave their cycles against the same file.
const writeTails = new Map<string, Promise<void>>()

export async function readSubagentRunIndex(runsPath: string): Promise<SubagentRunIndexFile | undefined> {
	let raw: string
	try {
		raw = await fs.readFile(runsPath, "utf8")
	} catch (error) {
		// ENOENT is the normal case for a task that ran no subagents — it must not log an error.
		if (hasErrorCode(error, "ENOENT")) {
			return undefined
		}
		Logger.warn(`[SubagentRunIndex] Failed to read ${runsPath}`, error)
		return undefined
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (error) {
		// A half-written sidecar must read as "no data", never as a crash in whatever is rendering it.
		Logger.warn(`[SubagentRunIndex] Unparseable sidecar at ${runsPath}`, error)
		return undefined
	}
	if (!isShapedLikeIndexFile(parsed)) {
		Logger.warn(`[SubagentRunIndex] Unexpected sidecar shape at ${runsPath}`)
		return undefined
	}
	return parsed
}

/**
 * A change to one run. Only `runId` is required: a run is written twice — once when it starts, with
 * its identity and prompt, and once when it settles, with only what settling produced.
 */
export type SubagentRunUpdate = Partial<SubagentRunRecord> & { runId: string }

export async function upsertSubagentRun(runsPath: string, taskId: string, record: SubagentRunUpdate): Promise<void> {
	const previous = writeTails.get(runsPath) ?? Promise.resolve()
	const operation = previous.then(() => writeMergedIndex(runsPath, taskId, record))
	// The stored tail swallows failures so one bad write never blocks later runs;
	// the error is reported to this caller below.
	const tail = operation.catch(() => undefined)
	writeTails.set(runsPath, tail)
	try {
		await operation
	} catch (error) {
		// A failed sidecar write must not fail a subagent run — log and return.
		Logger.error(`[SubagentRunIndex] Failed to update ${runsPath}`, error)
	} finally {
		if (writeTails.get(runsPath) === tail) {
			writeTails.delete(runsPath)
		}
	}
}

async function writeMergedIndex(runsPath: string, taskId: string, record: SubagentRunUpdate): Promise<void> {
	await fs.mkdir(path.dirname(runsPath), { recursive: true })
	const current = await readSubagentRunIndex(runsPath)
	const file: SubagentRunIndexFile = current ?? { version: SUBAGENT_RUNS_VERSION, taskId, runs: [] }
	const existingIndex = file.runs.findIndex((entry) => entry.runId === record.runId)
	if (existingIndex === -1) {
		const created = asCompleteRecord(record)
		if (!created) {
			// A terminal update with no "running" entry to merge onto means the start write failed.
			// Inventing an agent identity to satisfy the shape would put a fabricated run on disk,
			// which is worse than a missing one: the map would draw it as real.
			Logger.warn(`[SubagentRunIndex] Dropping update for unknown run ${record.runId} in ${runsPath}`)
			return
		}
		file.runs.push(created)
	} else {
		file.runs[existingIndex] = mergeRecord(file.runs[existingIndex], record)
	}
	await fs.writeFile(runsPath, JSON.stringify(file, null, 2), "utf8")
}

// Merge, not replace: a later call that omits a field must not erase what an
// earlier call recorded (e.g. the "running" record's prompt surviving into the
// terminal record, which does not repeat it).
function mergeRecord(existing: SubagentRunRecord, incoming: SubagentRunUpdate): SubagentRunRecord {
	return {
		...existing,
		runId: incoming.runId,
		agentId: incoming.agentId ?? existing.agentId,
		agentName: incoming.agentName ?? existing.agentName,
		status: incoming.status ?? existing.status,
		startedAt: incoming.startedAt ?? existing.startedAt,
		taskTitle: incoming.taskTitle ?? existing.taskTitle,
		prompt: incoming.prompt ?? existing.prompt,
		endedAt: incoming.endedAt ?? existing.endedAt,
		modelId: incoming.modelId ?? existing.modelId,
		providerId: incoming.providerId ?? existing.providerId,
		usage: incoming.usage ?? existing.usage,
		transcriptPath: incoming.transcriptPath ?? existing.transcriptPath,
		error: incoming.error ?? existing.error,
	}
}

/** An update can only become a NEW entry when it carries the identity a run is drawn with. */
function asCompleteRecord(record: SubagentRunUpdate): SubagentRunRecord | undefined {
	if (record.agentId === undefined || record.agentName === undefined || record.startedAt === undefined) {
		return undefined
	}
	return {
		...record,
		agentId: record.agentId,
		agentName: record.agentName,
		startedAt: record.startedAt,
		status: record.status ?? "running",
	}
}

function isShapedLikeIndexFile(value: unknown): value is SubagentRunIndexFile {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false
	}
	const candidate = value as Record<string, unknown>
	return typeof candidate.version === "number" && Array.isArray(candidate.runs)
}

function hasErrorCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code
	)
}
