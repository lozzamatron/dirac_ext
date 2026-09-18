import { Logger } from "@/shared/services/Logger"
import type { DiracWebviewProvider } from "./WebviewProvider"

/**
 * The kind of UI surface a webview instance is hosted in.
 *
 * `"fleet"` is the Fleet Map panel (WP5b). It hosts the same webview bundle as the chat surfaces but
 * owns a controller it never uses, and nearly every consumer of this registry must skip it — see the
 * per-method comments for what goes wrong when one does not.
 */
export type WebviewSurface = "sidebar" | "tab" | "fleet"

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

	private readonly changeListeners = new Set<() => void>()

	/** Adds an instance to the registry (idempotent). */
	register(instance: DiracWebviewProvider): void {
		this.instances.add(instance)
		this.notifyChanged()
	}

	/** Removes an instance, clearing `lastActive` if it pointed at it. */
	unregister(instance: DiracWebviewProvider): void {
		this.instances.delete(instance)
		if (this.lastActive === instance) {
			this.lastActive = undefined
		}
		this.notifyChanged()
	}

	/**
	 * Records the instance as last active; ignores instances that are not registered.
	 *
	 * A fleet instance is ignored even when registered: it is never the chat the user is working in,
	 * and recording it would let `lastActiveInstance()` hand "Add to Dirac" to a panel with no chat
	 * input — the text would be routed there and disappear.
	 */
	markActive(instance: DiracWebviewProvider): void {
		if (!this.instances.has(instance)) {
			return
		}
		if (instance.surface === "fleet") {
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

	/**
	 * All registered tab instances, in insertion order.
	 *
	 * The `surface === "tab"` filter already excludes fleet instances — a fleet panel is neither a
	 * sidebar nor a tab — which is what the tab-count UI wants: the fleet panel is not a chat tab
	 * and must not be counted as one.
	 */
	tabs(): DiracWebviewProvider[] {
		const result: DiracWebviewProvider[] = []
		for (const instance of this.instances) {
			if (instance.surface === "tab") {
				result.push(instance)
			}
		}
		return result
	}

	/**
	 * All registered fleet-panel instances, in insertion order.
	 *
	 * The fleet panel is a singleton in practice, but the registry does not enforce that — the
	 * opener does — so this returns a list rather than a single instance.
	 */
	fleet(): DiracWebviewProvider[] {
		const result: DiracWebviewProvider[] = []
		for (const instance of this.instances) {
			if (instance.surface === "fleet") {
				result.push(instance)
			}
		}
		return result
	}

	/**
	 * Every instance that is not a fleet panel, in insertion order.
	 *
	 * This is the listing the fleet map itself consumes: a fleet panel must never appear in its own
	 * listing, or the map would show the map.
	 */
	nonFleet(): DiracWebviewProvider[] {
		const result: DiracWebviewProvider[] = []
		for (const instance of this.instances) {
			if (instance.surface !== "fleet") {
				result.push(instance)
			}
		}
		return result
	}

	/**
	 * The last registered non-fleet instance that reports itself as visible.
	 *
	 * Fleet instances are skipped: a visible fleet panel is not a chat the user is talking to, and
	 * handing it the last-active crown would route editor-context commands into a panel that cannot
	 * accept them.
	 */
	visible(): DiracWebviewProvider | undefined {
		let found: DiracWebviewProvider | undefined
		for (const instance of this.instances) {
			if (instance.surface !== "fleet" && instance.isVisible()) {
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
	 *
	 * A fleet instance is never returned, at any of the five steps. Every fallback exists to find a
	 * chat for a command meant for a chat; a fleet panel has no chat in it, so routing to it makes
	 * the command's effect — added text, a re-enabled UI, a relinquish-control event — disappear
	 * into a panel that cannot show it.
	 */
	lastActiveInstance(): DiracWebviewProvider | undefined {
		const recorded = this.lastActive
		if (recorded && this.instances.has(recorded) && recorded.isVisible() && recorded.surface !== "fleet") {
			return recorded
		}

		const visibleInstance = this.visible()
		if (visibleInstance) {
			return visibleInstance
		}

		if (recorded && this.instances.has(recorded) && recorded.surface !== "fleet") {
			return recorded
		}

		const sidebarInstance = this.sidebar()
		if (sidebarInstance) {
			return sidebarInstance
		}

		let mostRecent: DiracWebviewProvider | undefined
		for (const instance of this.nonFleet()) {
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
		if (this.nonFleet().length > 1) {
			// With several instances this fallback can re-enable the WRONG webview's UI, so make
			// the mis-route diagnosable instead of silent.
			Logger.warn(`[WebviewInstanceRegistry] no instance owns task ${taskId ?? "<none>"}; falling back to last active`)
		}
		return this.lastActiveInstance()?.controller.id
	}

	/** Number of registered instances, fleet panels included. */
	count(): number {
		return this.instances.size
	}

	/**
	 * Subscribes to registry membership changes.
	 *
	 * This is what the fleet snapshot rebuild hangs off: an instance appearing or disappearing must
	 * reach the fleet panel without it polling. Deliberately NOT fired by `markActive` — focus
	 * changes fire constantly and carry no fleet-visible information, so they would only burn
	 * rebuilds.
	 *
	 * @param listener Invoked after a register or unregister
	 * @returns A handle whose `dispose()` removes the listener
	 */
	onDidChange(listener: () => void): { dispose(): void } {
		this.changeListeners.add(listener)
		return {
			dispose: () => {
				this.changeListeners.delete(listener)
			},
		}
	}

	/**
	 * Notifies every change listener. One listener that throws must not stop the others — the same
	 * protection `disposeAll()` gives itself against one failing dispose — or a broken subscriber
	 * would leave the rest of the fleet stale.
	 */
	private notifyChanged(): void {
		for (const listener of Array.from(this.changeListeners)) {
			try {
				listener()
			} catch (error) {
				Logger.error("[WebviewInstanceRegistry] change listener failed:", error)
			}
		}
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
