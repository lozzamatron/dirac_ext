import fs from "node:fs/promises"
import path from "node:path"
import { lock, type ReleaseLock } from "proper-lockfile"

/** Acquires exclusive task ownership across all hosts before any history is restored or written. */
export async function acquireTaskLock(taskDirectory: string): Promise<ReleaseLock> {
	await fs.mkdir(path.dirname(taskDirectory), { recursive: true })
	try {
		return await lock(taskDirectory, {
			realpath: false,
			stale: 30_000,
			update: 5_000,
			retries: 0,
		})
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error
		throw new Error("This task is already open in another Dirac instance. Close it there before opening it here.", {
			cause: error,
		})
	}
}
