/**
 * Derives a human-readable webview title from the state publication pipeline.
 *
 * Every editor tab today is titled "Dirac EXT", so several open conversations are
 * indistinguishable. Deriving the title here, in core, means every host gets the
 * same rule; only hosts with a titled surface act on it.
 */
import type { ExtensionState } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { webviewInstances } from "./InstanceRegistry"

export const DEFAULT_WEBVIEW_TITLE = "Dirac EXT"
export const MAX_WEBVIEW_TITLE_LENGTH = 40

/**
 * Collapses whitespace and truncates a task string to a single-line tab title.
 * @param task The human text of the conversation, if any
 * @returns A title at most MAX_WEBVIEW_TITLE_LENGTH characters long
 */
export function formatTaskTitle(task?: string): string {
	if (task === undefined || task.trim().length === 0) {
		return DEFAULT_WEBVIEW_TITLE
	}

	// An editor tab is one line high, so a multi-line first message must not
	// make the title ragged: collapse every whitespace run to a single space.
	const collapsed = task.replace(/\s+/g, " ").trim()

	if (collapsed.length <= MAX_WEBVIEW_TITLE_LENGTH) {
		return collapsed
	}

	// Reserve one character for the ellipsis.
	const slice = collapsed.slice(0, MAX_WEBVIEW_TITLE_LENGTH - 1)

	// End on a word boundary instead of mid-word, but only if the cut still
	// keeps a meaningful amount of text (at least half the budget).
	const half = Math.floor(MAX_WEBVIEW_TITLE_LENGTH / 2)
	let cut = slice
	for (let i = slice.length - 1; i >= half; i--) {
		if (slice[i] === " ") {
			cut = slice.slice(0, i)
			break
		}
	}

	return `${cut.trimEnd()}…`
}

/**
 * Applies a title derived from a task's own text to the instance a controller owns.
 *
 * Called when a task starts, because the state pipeline cannot supply a title that early: its
 * `currentTaskItem` is looked up in the persisted task history, which has no entry for a brand-new
 * conversation until its first result is written. Without this the tab — and the background-task list,
 * if the tab is closed mid-turn — would show the placeholder for the whole first turn.
 *
 * @param controllerId The id of the controller that owns the task
 * @param task The task's text, or undefined to reset to the default title
 */
export function applyTaskTitle(controllerId: string, task?: string): void {
	try {
		const instance = webviewInstances.byControllerId(controllerId)
		if (!instance) {
			return
		}
		instance.setTitle(formatTaskTitle(task))
	} catch (error) {
		// A window title is cosmetic and must never break task startup.
		Logger.debug(`Failed to apply task title for controller ${controllerId}: ${error}`)
	}
}

/**
 * Applies the task-derived title to the webview instance owned by a controller.
 * @param controllerId The id of the controller that published the state
 * @param state The partial state being published
 */
export function applyStateTitle(controllerId: string, state: Partial<ExtensionState>): void {
	// Only "control" publications carry currentTaskItem; a "presentation" one omits
	// the key entirely. Treating an absent key as "no task" would blank a live
	// tab's title mid-turn, so bail out before touching the instance.
	if (!("currentTaskItem" in state)) {
		return
	}

	// A live run always sets presentationSurfaceId. Until its history entry carries display text, the
	// title applyTaskTitle set at startup is the only one there is — falling back to the placeholder
	// here would undo it on every publication of the first turn. A run with no text of its own (one
	// started from images or files alone) keeps whatever startup gave it rather than flickering.
	if (state.presentationSurfaceId && !state.currentTaskItem?.task) {
		return
	}

	applyTaskTitle(controllerId, state.currentTaskItem?.task)
}
