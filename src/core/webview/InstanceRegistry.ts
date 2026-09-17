import { Logger } from "@/shared/services/Logger"
import type { DiracWebviewProvider } from "./WebviewProvider"

/**
 * The kind of UI surface a webview instance is hosted in.
 */
export type WebviewSurface = "sidebar" | "tab"

/**
 * Process-local registry of live {@link DiracWebviewProvider} instances.
 *
 * This replaces the old `static instance` singleton on the provider: a single
 * extension host can now own one sidebar instance plus any number of editor-tab
 * instances, and every one of them is tracked here in insertion order.
 *
 * The registry also tracks the "last active" instance, which is what
 * editor-context commands (Add to Dirac / Explain / Fix) route to when they
 * need to pick a target webview without an explicit one.
 */
export class WebviewInstanceRegistry {
	private readonly instances = new Set<DiracWebviewProvider>()
	private lastActive: DiracWebviewProvider | undefined

	/** Adds an instance to the registry (idempotent). */
	register(instance: DiracWebviewProvider): void {
		this.instances.add(instance)
	}

	/** Removes an instance, clearing `lastActive` if it pointed at it. */
	unregister(instance: DiracWebviewProvider): void {
		this.instances.delete(instance)
		if (this.lastActive === instance) {
			this.lastActive = undefined
		}
	}

	/** Records the instance as last active; ignores instances that are not registered. */
	markActive(instance: DiracWebviewProvider): void {
		if (!this.instances.has(instance)) {
			return
		}
		this.lastActive = instance
	}

	/** All registered instances, in insertion order. */
	all(): DiracWebviewProvider[] {
		return Array.from(this.instances)
	}

	/** The first registered sidebar instance, if any. */
	sidebar(): DiracWebviewProvider | undefined {
		for (const instance of this.instances) {
			if (instance.surface === "sidebar") {
				return instance
			}
		}
		return undefined
	}

	/** All registered tab instances, in insertion order. */
	tabs(): DiracWebviewProvider[] {
		const result: DiracWebviewProvider[] = []
		for (const instance of this.instances) {
			if (instance.surface === "tab") {
				result.push(instance)
			}
		}
		return result
	}

	/** The last registered instance that reports itself as visible. */
	visible(): DiracWebviewProvider | undefined {
		let found: DiracWebviewProvider | undefined
		for (const instance of this.instances) {
			if (instance.isVisible()) {
				found = instance
			}
		}
		return found
	}

	/**
	 * Resolves the instance that commands should target, in priority order:
	 * the recorded last-active (if still registered and visible), the last
	 * visible instance, the recorded last-active (if still registered), the
	 * sidebar, the most recently registered instance, or `undefined`.
	 */
	lastActiveInstance(): DiracWebviewProvider | undefined {
		const recorded = this.lastActive
		if (recorded && this.instances.has(recorded) && recorded.isVisible()) {
			return recorded
		}

		const visibleInstance = this.visible()
		if (visibleInstance) {
			return visibleInstance
		}

		if (recorded && this.instances.has(recorded)) {
			return recorded
		}

		const sidebarInstance = this.sidebar()
		if (sidebarInstance) {
			return sidebarInstance
		}

		let mostRecent: DiracWebviewProvider | undefined
		for (const instance of this.instances) {
			mostRecent = instance
		}
		return mostRecent
	}

	/** Finds the instance whose controller has the given id. */
	byControllerId(id: string): DiracWebviewProvider | undefined {
		for (const instance of this.instances) {
			if (instance.controller.id === id) {
				return instance
			}
		}
		return undefined
	}

	/**
	 * Resolves the id of the controller that owns a given task.
	 *
	 * Some events are fired deep inside task code — "relinquish control" from the checkpoint
	 * handlers, for instance — where no controller is in scope, only a task id. Falls back to the
	 * last-active instance so such an event is never silently dropped (it would leave the webview's
	 * UI disabled). Goal child tasks resolve through the fallback, not the exact match.
	 */
	controllerIdForTask(taskId?: string): string | undefined {
		if (taskId) {
			for (const instance of this.instances) {
				if (instance.controller.task?.taskId === taskId) {
					return instance.controller.id
				}
			}
		}
		if (this.instances.size > 1) {
			// With several instances this fallback can re-enable the WRONG webview's UI, so make
			// the mis-route diagnosable instead of silent.
			Logger.warn(`[WebviewInstanceRegistry] no instance owns task ${taskId ?? "<none>"}; falling back to last active`)
		}
		return this.lastActiveInstance()?.controller.id
	}

	/** Number of registered instances. */
	count(): number {
		return this.instances.size
	}

	/**
	 * Disposes every registered instance. Iterates over a copy because
	 * `dispose()` unregisters the instance as a side effect, then clears the
	 * registry and the last-active reference.
	 */
	async disposeAll(): Promise<void> {
		const snapshot = Array.from(this.instances)
		for (const instance of snapshot) {
			try {
				await instance.dispose()
			} catch (error) {
				// One failing dispose must not strand the remaining instances in the registry,
				// where `lastActiveInstance()` could later hand out a half-disposed provider.
				Logger.error("[WebviewInstanceRegistry] dispose failed for an instance:", error)
			}
		}
		this.instances.clear()
		this.lastActive = undefined
	}
}

/** Shared process-local registry for all live Dirac webview instances. */
export const webviewInstances = new WebviewInstanceRegistry()
