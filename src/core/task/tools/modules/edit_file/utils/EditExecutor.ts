import { ToolUse } from "@core/assistant-message";
import { containsAnchoredLine, getDelimiter, parseAnchoredLine } from "@utils/line-hashing";
import { AppliedEdit, Edit, FailedEdit, ResolvedEdit } from "../types";

const EDIT_TYPES = new Set<Edit["edit_type"]>(["replace", "insert_after", "insert_before"])

export class EditExecutor {
	resolveEdits(
		blocks: ToolUse[],
		lines: string[],
		lineAnchors: string[],
	): { resolvedEdits: ResolvedEdit[]; failedEdits: FailedEdit[] } {
		const failedEdits: FailedEdit[] = []
		const resolvedEdits: ResolvedEdit[] = []

		for (const block of blocks) {
			const edits = (block.params.edits as Edit[]) || []
			for (const [editIndex, edit] of edits.entries()) {
				const shapeError = this.validateEdit(edit)
				if (shapeError) {
					failedEdits.push({ edit: edit ?? ({} as Edit), error: shapeError, editIndex })
					continue
				}

				const diagnostics: string[] = []
				const start = this.resolveAnchor("anchor", edit.anchor, lineAnchors, lines)
				if (start.error) diagnostics.push(start.error)

				let endIdx = start.index
				if (edit.edit_type === "replace") {
					const end = this.resolveAnchor("end_anchor", edit.end_anchor, lineAnchors, lines)
					if (end.error) diagnostics.push(end.error)
					endIdx = end.index
				}
				if (start.index !== -1 && endIdx !== -1 && endIdx < start.index) {
					diagnostics.push("Range error: anchor must precede or equal end_anchor.")
				}

				if (diagnostics.length > 0) {
					failedEdits.push({ edit, error: diagnostics.join(" "), editIndex })
				} else {
					resolvedEdits.push({ lineIdx: start.index, endIdx, edit, editIndex })
				}
			}
		}

		const conflicts = this.findConflicts(resolvedEdits, lines)
		if (conflicts.size === 0) return { resolvedEdits, failedEdits }
		for (const resolved of resolvedEdits) {
			const messages = conflicts.get(resolved)
			if (!messages) continue
			failedEdits.push({ edit: resolved.edit, editIndex: resolved.editIndex, error: messages.join(" ") })
		}
		return { resolvedEdits: resolvedEdits.filter((edit) => !conflicts.has(edit)), failedEdits }
	}

	private validateEdit(edit: Edit | undefined): string | undefined {
		if (!edit || typeof edit !== "object" || Array.isArray(edit)) return "The edit must be an object."
		if (!EDIT_TYPES.has(edit.edit_type)) {
			return "edit_type is required and must be replace, insert_after, or insert_before."
		}
		if (typeof edit.text !== "string") return "text is required and must be a string."
		if (containsAnchoredLine(edit.text)) {
			return "text must contain ordinary source text only; remove line anchors from replacement text."
		}
		if (edit.edit_type === "replace" && (typeof edit.end_anchor !== "string" || edit.end_anchor.length === 0)) {
			return "end_anchor is required for replace edits."
		}
		return undefined
	}

	resolveAnchor(
		type: "anchor" | "end_anchor",
		rawAnchor: string | undefined,
		lineAnchors: string[],
		lines: string[],
	): { index: number; error?: string } {
		if (typeof rawAnchor !== "string" || rawAnchor.length === 0) return { index: -1, error: `${type} is missing.` }
		const parsed = parseAnchoredLine(rawAnchor)
		if (!parsed) {
			return {
				index: -1,
				error: `${type} must be one complete anchored source line in the form ANCHOR${getDelimiter()}CONTENT, copied verbatim from current anchored output.`,
			}
		}

		const matchingIndices: number[] = []
		for (let index = 0; index < lineAnchors.length; index++) {
			if (lineAnchors[index] === parsed.anchor) matchingIndices.push(index)
		}
		if (matchingIndices.length === 0) {
			return {
				index: -1,
				error: `${type} line ID "${parsed.anchor}" was not found. Reread the smallest relevant range with include_anchors: true and copy the current complete line.`,
			}
		}
		if (matchingIndices.length > 1) {
			return { index: -1, error: `${type} line ID "${parsed.anchor}" resolves to multiple lines; the anchor state is invalid.` }
		}

		const index = matchingIndices[0]
		if (parsed.content !== lines[index]) {
			return {
				index: -1,
				error: `${type} has a valid line ID but the paired content does not exactly match the current source line. Expected: "${lines[index]}", Provided: "${parsed.content}".`,
			}
		}
		return { index }
	}

	private findConflicts(resolvedEdits: ResolvedEdit[], lines: string[]): Map<ResolvedEdit, string[]> {
		const conflicts = new Map<ResolvedEdit, string[]>()
		for (let leftIndex = 0; leftIndex < resolvedEdits.length; leftIndex++) {
			for (let rightIndex = leftIndex + 1; rightIndex < resolvedEdits.length; rightIndex++) {
				const left = resolvedEdits[leftIndex]
				const right = resolvedEdits[rightIndex]
				if (!this.editsConflict(left, right, lines)) continue
				this.addConflict(conflicts, left, `Overlaps files edit index ${right.editIndex}; neither conflicting edit was applied.`)
				this.addConflict(conflicts, right, `Overlaps files edit index ${left.editIndex}; neither conflicting edit was applied.`)
			}
		}
		return conflicts
	}

	private addConflict(conflicts: Map<ResolvedEdit, string[]>, edit: ResolvedEdit, message: string): void {
		const messages = conflicts.get(edit) ?? []
		messages.push(message)
		conflicts.set(edit, messages)
	}

	private editsConflict(left: ResolvedEdit, right: ResolvedEdit, lines: string[]): boolean {
		const leftReplace = left.edit.edit_type === "replace"
		const rightReplace = right.edit.edit_type === "replace"
		if (leftReplace && rightReplace) return left.lineIdx <= right.endIdx && right.lineIdx <= left.endIdx
		if (!leftReplace && !rightReplace) return this.insertionBoundary(left, lines) === this.insertionBoundary(right, lines)

		const replacement = leftReplace ? left : right
		const insertion = leftReplace ? right : left
		return insertion.lineIdx >= replacement.lineIdx && insertion.lineIdx <= replacement.endIdx
	}

	private insertionBoundary(edit: ResolvedEdit, lines: string[]): number {
		if (edit.edit.edit_type !== "insert_after") return edit.lineIdx
		// The final empty line in a newline-terminated file is the EOF insertion point.
		if (edit.lineIdx === lines.length - 1 && lines.length > 1 && lines[edit.lineIdx] === "") return edit.lineIdx
		return edit.lineIdx + 1
	}

	applyEdits(
		lines: string[],
		resolvedEdits: ResolvedEdit[],
	): { finalLines: string[]; addedCount: number; removedCount: number; appliedEdits: AppliedEdit[] } {
		const sortedEdits = [...resolvedEdits].sort((left, right) => right.lineIdx - left.lineIdx)
		const newLines = [...lines]
		let addedCount = 0
		let removedCount = 0
		const changes: Array<{ originalLineIdx: number; replacementCount: number; removedCount: number; edit: Edit }> = []

		for (const resolved of sortedEdits) {
			const { lineIdx, endIdx, edit } = resolved
			const replacementLines = edit.text === "" ? [] : edit.text.split(/\r?\n/)
			const spliceIndex = edit.edit_type === "replace" ? lineIdx : this.insertionBoundary(resolved, lines)
			const removedInThisEdit = edit.edit_type === "replace" ? endIdx - lineIdx + 1 : 0
			// A terminal newline separates text from the next source line; it is not an extra blank line.
			if (edit.text.endsWith("\n") && spliceIndex + removedInThisEdit < newLines.length) {
				replacementLines.pop()
			}
			newLines.splice(spliceIndex, removedInThisEdit, ...replacementLines)
			addedCount += replacementLines.length
			removedCount += removedInThisEdit
			changes.push({ originalLineIdx: lineIdx, replacementCount: replacementLines.length, removedCount: removedInThisEdit, edit })
		}

		const appliedEdits = changes.map((change) => {
			let shift = 0
			for (const other of changes) {
				if (other.originalLineIdx < change.originalLineIdx) shift += other.replacementCount - other.removedCount
			}
			return {
				startIdx: change.originalLineIdx + shift,
				endIdx: change.originalLineIdx + shift + change.replacementCount - 1,
				originalStartIdx: change.originalLineIdx,
				originalEndIdx: change.originalLineIdx + change.removedCount - 1,
				edit: change.edit,
				linesAdded: change.replacementCount,
				linesDeleted: change.removedCount,
			}
		})
		return { finalLines: newLines, addedCount, removedCount, appliedEdits }
	}

	formatFailureMessage(edit: Edit, error?: string, location?: { fileIndex: number; editIndex: number }): string {
		const locationPrefix = location ? `files[${location.fileIndex}].edits[${location.editIndex}] ` : "Edit "
		return `${locationPrefix}(anchor: "${edit?.anchor}", end_anchor: "${edit?.end_anchor}") failed. Diagnostics: ${error ?? "The complete anchored coordinate was invalid."}`
	}
}
