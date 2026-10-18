import fs from "fs/promises"
import path from "path"
import { HostProvider } from "@/hosts/host-provider"

function assertTaskDirectoryId(taskId: string): void {
	if (!taskId || taskId === "." || taskId === ".." || taskId.includes("/") || taskId.includes("\\") || taskId.includes("\0")) {
		throw new Error(`Invalid task directory identity: ${JSON.stringify(taskId)}`)
	}
}

export function getTasksDirectoryPath(): string {
	return path.resolve(HostProvider.get().globalStorageFsPath, "tasks")
}

export function getTaskDirectoryPath(taskId: string): string {
	assertTaskDirectoryId(taskId)
	return path.join(getTasksDirectoryPath(), taskId)
}

export async function listTaskDirectoryIds(): Promise<string[]> {
	try {
		const entries = await fs.readdir(getTasksDirectoryPath(), { withFileTypes: true })
		return entries.filter((entry) => entry.isDirectory() && !entry.name.endsWith(".lock")).map((entry) => entry.name)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}
}

/** Deletes every persisted artifact owned by one Task-shaped run directory. */
export async function deleteTaskDirectory(taskId: string): Promise<void> {
	await fs.rm(getTaskDirectoryPath(taskId), { recursive: true, force: true })
}
