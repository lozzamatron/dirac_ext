import { atomicWriteFile } from "@core/storage/atomicWrite"
import { ensureTaskDirectoryExists } from "@core/storage/directoryEnsurers"
import { getTaskDirectoryPath, listTaskDirectoryIds } from "@core/storage/taskDirectory"
import { acquireTaskLock } from "@core/task/TaskLockUtils"
import { type GoalRecord, type GoalStatusTransition, isActiveGoalStatus, isSettledGoalStatus } from "@shared/goal"
import { fileExistsAtPath } from "@utils/fs"
import fs from "fs/promises"
import Mutex from "p-mutex"
import path from "path"
import { applyGoalStatusTransition, interruptNonterminalGoalChildren } from "./GoalLifecycle"
import { assertGoalRecord } from "./validateGoalRecord"

const GOAL_STATE_FILE = "goal.json"
const goalLocks = new Map<string, Mutex>()

export type GoalRecordUpdate = (record: GoalRecord, now: number) => void | Promise<void>

export interface GoalStartupReconciliationFailure {
	goalId: string
	error: Error
}

export interface GoalStartupReconciliationReport {
	records: GoalRecord[]
	failures: GoalStartupReconciliationFailure[]
}

interface GoalLifecycleSnapshot {
	status: GoalRecord["status"]
	statusReason?: string
	activeDurationMs: number
	lastActivatedAt?: number
	lastPausedAt?: number
}

function goalLock(goalId: string): Mutex {
	let lock = goalLocks.get(goalId)
	if (!lock) {
		lock = new Mutex()
		goalLocks.set(goalId, lock)
	}
	return lock
}

async function withGoalLock<T>(goalId: string, operation: () => Promise<T>): Promise<T> {
	const lock = goalLock(goalId)
	try {
		return await lock.withLock(operation)
	} finally {
		if (!lock.isLocked && goalLocks.get(goalId) === lock) goalLocks.delete(goalId)
	}
}

function goalStatePath(goalId: string): string {
	return path.join(getTaskDirectoryPath(goalId), GOAL_STATE_FILE)
}

function lifecycleSnapshot(record: GoalRecord): GoalLifecycleSnapshot {
	return {
		status: record.status,
		statusReason: record.statusReason,
		activeDurationMs: record.activeDurationMs,
		lastActivatedAt: record.lastActivatedAt,
		lastPausedAt: record.lastPausedAt,
	}
}

function assertLifecycleUnchanged(record: GoalRecord, before: GoalLifecycleSnapshot): void {
	const after = lifecycleSnapshot(record)
	if (
		after.status !== before.status ||
		after.statusReason !== before.statusReason ||
		after.activeDurationMs !== before.activeDurationMs ||
		after.lastActivatedAt !== before.lastActivatedAt ||
		after.lastPausedAt !== before.lastPausedAt
	) {
		throw new Error(`Goal ${record.id} lifecycle fields may only change through GoalStore.transition`)
	}
}

function assertClockTime(now: number): void {
	if (!Number.isFinite(now) || now < 0) throw new Error("GoalStore clock returned an invalid timestamp")
}

async function readGoalRecord(goalId: string): Promise<GoalRecord> {
	const filePath = goalStatePath(goalId)
	if (!(await fileExistsAtPath(filePath))) throw new Error(`Goal ${goalId} does not exist`)
	const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"))
	assertGoalRecord(parsed, goalId)
	return parsed
}

async function containsCurrentGoalRecord(goalId: string): Promise<boolean> {
	const filePath = goalStatePath(goalId)
	if (!(await fileExistsAtPath(filePath))) return false
	const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"))
	if (isSupersededGoalRecord(parsed)) return false
	assertGoalRecord(parsed, goalId)
	return true
}

function isSupersededGoalRecord(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const record = value as Record<string, unknown>
	return record.version === undefined && typeof record.schemaVersion === "number"
}

async function writeGoalRecord(record: GoalRecord): Promise<void> {
	assertGoalRecord(record, record.id)
	await atomicWriteFile(goalStatePath(record.id), JSON.stringify(record, null, 2))
}

export class GoalStore {
	constructor(private readonly clock: () => number = Date.now) {}

	async create(goalId: string, conversationUlid: string, objectiveMarkdown: string): Promise<GoalRecord> {
		if (!objectiveMarkdown.trim()) throw new Error("A Goal objective cannot be empty")
		if (!conversationUlid) throw new Error("A Goal conversation ULID cannot be empty")
		return withGoalLock(goalId, async () => {
			const releaseOwnership = await acquireTaskLock(getTaskDirectoryPath(goalId))
			try {
				const filePath = goalStatePath(goalId)
				if (await fileExistsAtPath(filePath)) throw new Error(`Goal ${goalId} already exists`)
				const now = this.clock()
				assertClockTime(now)
				await ensureTaskDirectoryExists(goalId)
				const record: GoalRecord = {
					version: 1,
					id: goalId,
					conversationUlid,
					status: "paused",
					statusReason: "Created",
					objective: { markdown: objectiveMarkdown, revision: 1, updatedAt: now },
					createdAt: now,
					updatedAt: now,
					lastPausedAt: now,
					activeDurationMs: 0,
					wakeSequence: 0,
					eventSequence: 0,
					events: [],
					children: [],
					accountingSources: {},
					accounting: {},
				}
				await writeGoalRecord(record)
				return structuredClone(record)
			} finally {
				await releaseOwnership()
			}
		})
	}

	async read(goalId: string): Promise<GoalRecord> {
		return withGoalLock(goalId, async () => structuredClone(await readGoalRecord(goalId)))
	}

	async list(): Promise<GoalRecord[]> {
		const taskIds = await listTaskDirectoryIds()
		const goalIds: string[] = []
		for (const taskId of taskIds) {
			if (await containsCurrentGoalRecord(taskId)) goalIds.push(taskId)
		}
		const records = await Promise.all(goalIds.map((goalId) => this.read(goalId)))
		return records.sort((left, right) => left.createdAt - right.createdAt)
	}

	async update(goalId: string, update: GoalRecordUpdate): Promise<GoalRecord> {
		return withGoalLock(goalId, async () => {
			const record = await readGoalRecord(goalId)
			const now = this.clock()
			assertClockTime(now)
			if (now < record.updatedAt) throw new Error(`Goal ${goalId} update time predates its persisted state`)
			const before = lifecycleSnapshot(record)
			await update(record, now)
			assertLifecycleUnchanged(record, before)
			record.updatedAt = now
			await writeGoalRecord(record)
			return structuredClone(record)
		})
	}

	async transition(goalId: string, transition: GoalStatusTransition, mutate?: GoalRecordUpdate): Promise<GoalRecord> {
		return withGoalLock(goalId, async () => {
			const record = await readGoalRecord(goalId)
			if (record.status === transition.status) return structuredClone(record)
			const now = this.clock()
			assertClockTime(now)
			if (now < record.updatedAt) throw new Error(`Goal ${goalId} transition time predates its persisted state`)
			const before = lifecycleSnapshot(record)
			if (mutate) await mutate(record, now)
			assertLifecycleUnchanged(record, before)
			applyGoalStatusTransition(record, transition, now)
			if (isSettledGoalStatus(record.status)) record.events = []
			await writeGoalRecord(record)
			return structuredClone(record)
		})
	}

	/** Removes only an unowned Goal record, for creation rollback. */
	async delete(goalId: string): Promise<void> {
		await withGoalLock(goalId, async () => {
			const releaseOwnership = await acquireTaskLock(getTaskDirectoryPath(goalId))
			try {
				await fs.rm(goalStatePath(goalId), { force: true })
			} finally {
				await releaseOwnership()
			}
		})
	}

	/** Discovery is read-only: another process may own any of these Goals. */
	async scanRecords(): Promise<GoalStartupReconciliationReport> {
		const records: GoalRecord[] = []
		const failures: GoalStartupReconciliationFailure[] = []
		for (const goalId of await listTaskDirectoryIds()) {
			try {
				if (await containsCurrentGoalRecord(goalId)) records.push(await this.read(goalId))
			} catch (error) {
				failures.push({ goalId, error: error instanceof Error ? error : new Error(String(error)) })
			}
		}
		return { records: records.sort((left, right) => left.createdAt - right.createdAt), failures }
	}

	/** Call only while holding this Goal's task-directory execution lock. */
	async recoverInterruptedExecution(goalId: string): Promise<GoalRecord> {
		return withGoalLock(goalId, async () => {
			const current = await readGoalRecord(goalId)
			const now = this.clock()
			assertClockTime(now)
			if (now < current.updatedAt) throw new Error(`Goal ${goalId} recovery time predates its persisted state`)
			const interruptedChildren = interruptNonterminalGoalChildren(current, now)
			const wasActive = isActiveGoalStatus(current.status)
			if (wasActive) {
				applyGoalStatusTransition(current, { status: "paused", statusReason: "Recovered interrupted execution" }, now)
			}
			if (interruptedChildren || wasActive) {
				current.events = []
				current.updatedAt = now
				await writeGoalRecord(current)
			}
			return structuredClone(current)
		})
	}
}
