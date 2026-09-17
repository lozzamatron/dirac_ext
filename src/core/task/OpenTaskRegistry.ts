import { Logger } from "@/shared/services/Logger"

/**
 * Reports a claim that was rejected because another controller in this process
 * already owns the task.
 *
 * The registry never throws for a conflict: the useful response is to surface
 * the webview that already owns the task (reveal it, show an information
 * message), which is a host concern the core layer must not know about.
 */
export type TaskConflictHandler = (conflict: {
	taskId: string
	ownerControllerId: string
	requestingControllerId: string
}) => void

/**
 * Process-local registry of tasks that are currently open in a controller.
 *
 * Dirac's SQLite task lock is keyed by a per-process instance address, so it
 * only arbitrates between different VS Code processes: two controllers inside
 * ONE extension host would both "acquire" the same task and then run the same
 * conversation twice, writing over each other's history. This registry is the
 * process-local guard that stops that. It complements the cross-process SQLite
 * lock rather than replacing it, and it never touches the lock or its
 * `held_by` value — a janitor deletes folder locks whose `held_by` is not a
 * registered instance address.
 *
 * Conflicts are reported through an optional {@link TaskConflictHandler}
 * instead of a thrown error because the caller should show the owning view
 * rather than fail the command.
 */
export class OpenTaskRegistry {
	private readonly owners = new Map<string, string>()
	private conflictHandler: TaskConflictHandler | undefined

	/** Registers the handler invoked when a claim is rejected; `undefined` clears it. */
	setConflictHandler(handler: TaskConflictHandler | undefined): void {
		this.conflictHandler = handler
	}

	/**
	 * Claims `taskId` for `controllerId`, returning true when the caller now
	 * owns the task.
	 *
	 * Idempotent: claiming a task you already own returns true. When another
	 * controller owns it, returns false and notifies the conflict handler.
	 */
	claim(taskId: string, controllerId: string): boolean {
		const owner = this.owners.get(taskId)
		if (owner === undefined) {
			this.owners.set(taskId, controllerId)
			return true
		}
		if (owner === controllerId) {
			return true
		}

		const handler = this.conflictHandler
		if (handler) {
			try {
				handler({ taskId, ownerControllerId: owner, requestingControllerId: controllerId })
			} catch (error) {
				// A throwing handler must not break task startup; the claim is still refused.
				Logger.error("[OpenTaskRegistry] conflict handler threw:", error)
			}
		}
		return false
	}

	/**
	 * Releases `taskId` only when `controllerId` is its owner, so a stale
	 * release from a previous owner cannot free someone else's claim.
	 */
	release(taskId: string, controllerId: string): void {
		if (this.owners.get(taskId) === controllerId) {
			this.owners.delete(taskId)
		}
	}

	/** Drops every claim held by `controllerId`; call it when a controller is disposed. */
	releaseAllFor(controllerId: string): void {
		for (const [taskId, owner] of this.owners) {
			if (owner === controllerId) {
				this.owners.delete(taskId)
			}
		}
	}

	/** The controller id that currently owns `taskId`, if any. */
	ownerOf(taskId: string): string | undefined {
		return this.owners.get(taskId)
	}

	/** True when `taskId` is claimed by a controller other than `controllerId`. */
	isOwnedByOther(taskId: string, controllerId: string): boolean {
		const owner = this.owners.get(taskId)
		return owner !== undefined && owner !== controllerId
	}

	/** Number of currently claimed tasks. */
	count(): number {
		return this.owners.size
	}

	/** Drops every claim; intended for tests. */
	clear(): void {
		this.owners.clear()
	}
}

/** Shared process-local registry for all tasks currently open in a controller. */
export const openTasks = new OpenTaskRegistry()
