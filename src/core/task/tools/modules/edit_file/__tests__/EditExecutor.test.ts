import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import type { ToolUse } from "@core/assistant-message"
import { getDelimiter } from "@utils/line-hashing"
import type { Edit } from "../types"
import { EditExecutor } from "../utils/EditExecutor"

const lines = ["first", "", "third"]
const lineAnchors = ["Apple", "Banana", "Cherry"]
const coordinate = (anchor: string, content: string) => `${anchor}${getDelimiter()}${content}`

function block(edits: Array<Edit | Record<string, unknown>>): ToolUse {
	return {
		type: "tool_use",
		name: "edit_file",
		params: { edits },
	} as ToolUse
}

describe("EditExecutor required-anchor contract", () => {
	it("resolves a complete coordinate for a blank source line", () => {
		const executor = new EditExecutor()
		const edit: Edit = {
			edit_type: "replace",
			anchor: coordinate("Banana", ""),
			end_anchor: coordinate("Banana", ""),
			text: "replacement",
		}

		const result = executor.resolveEdits([block([edit])], lines, lineAnchors)
		assert.equal(result.failedEdits.length, 0)
		assert.equal(result.resolvedEdits[0].lineIdx, 1)
		assert.equal(result.resolvedEdits[0].endIdx, 1)
	})

	it("rejects identifiers, line numbers, and search text without complete coordinates", () => {
		const executor = new EditExecutor()
		for (const malformed of ["Apple", "1", "first"]) {
			const edit: Edit = {
				edit_type: "replace",
				anchor: malformed,
				end_anchor: malformed,
				text: "replacement",
			}
			const result = executor.resolveEdits([block([edit])], lines, lineAnchors)
			assert.equal(result.resolvedEdits.length, 0)
			assert.match(result.failedEdits[0].error, /must be one complete anchored source line/)
		}
	})

	it("rejects an ID spliced together with another line's content", () => {
		const executor = new EditExecutor()
		const spliced = coordinate("Apple", "third")
		const edit: Edit = { edit_type: "replace", anchor: spliced, end_anchor: spliced, text: "replacement" }

		const result = executor.resolveEdits([block([edit])], lines, lineAnchors)
		assert.equal(result.resolvedEdits.length, 0)
		assert.match(result.failedEdits[0].error, /paired content does not exactly match/)
	})

	it("requires a known edit type and an end coordinate only for replace", () => {
		const executor = new EditExecutor()
		const anchor = coordinate("Apple", "first")
		const invalidType = executor.resolveEdits([
			block([{ edit_type: "remove", anchor, end_anchor: anchor, text: "" }]),
		], lines, lineAnchors)
		assert.match(invalidType.failedEdits[0].error, /edit_type is required/)

		const missingEnd = executor.resolveEdits([
			block([{ edit_type: "replace", anchor, text: "replacement" }]),
		], lines, lineAnchors)
		assert.match(missingEnd.failedEdits[0].error, /end_anchor is required for replace/)

		const insertion = executor.resolveEdits([
			block([{ edit_type: "insert_after", anchor, end_anchor: null, text: "inserted" }]),
		], lines, lineAnchors)
		assert.equal(insertion.failedEdits.length, 0)
		assert.equal(insertion.resolvedEdits.length, 1)
	})

	it("rejects anchored source lines in replacement text", () => {
		const executor = new EditExecutor()
		const anchor = coordinate("Apple", "first")
		const edit: Edit = {
			edit_type: "replace",
			anchor,
			end_anchor: anchor,
			text: coordinate("Cherry", "third"),
		}

		const result = executor.resolveEdits([block([edit])], lines, lineAnchors)
		assert.equal(result.resolvedEdits.length, 0)
		assert.match(result.failedEdits[0].error, /ordinary source text only/)
	})

	it("rejects anchored replacement lines separated with CRLF", () => {
		const executor = new EditExecutor()
		const anchor = coordinate("Apple", "first")
		const edit: Edit = {
			edit_type: "replace",
			anchor,
			end_anchor: anchor,
			text: `ordinary\r\n${coordinate("Cherry", "third")}`,
		}

		const result = executor.resolveEdits([block([edit])], lines, lineAnchors)
		assert.equal(result.resolvedEdits.length, 0)
		assert.match(result.failedEdits[0].error, /ordinary source text only/)
	})

	it("inserts terminated lines without adding a blank line before existing content", () => {
		const executor = new EditExecutor()
		const edit: Edit = { edit_type: "insert_before", anchor: coordinate("Cherry", "third"), text: "  inserted\n" }
		const { resolvedEdits } = executor.resolveEdits([block([edit])], lines, lineAnchors)
		assert.deepEqual(executor.applyEdits(lines, resolvedEdits).finalLines, ["first", "", "  inserted", "third"])
	})

	it("inserts an intentional blank line with two trailing newlines", () => {
		const executor = new EditExecutor()
		const edit: Edit = { edit_type: "insert_after", anchor: coordinate("Apple", "first"), text: "inserted\n\n" }
		const { resolvedEdits } = executor.resolveEdits([block([edit])], lines, lineAnchors)
		assert.deepEqual(executor.applyEdits(lines, resolvedEdits).finalLines, ["first", "inserted", "", "", "third"])
	})

	it("preserves a terminal newline for insertions and replacements at EOF", () => {
		const executor = new EditExecutor()
		const source = ["first"]
		const editAtEnd: Edit = { edit_type: "insert_after", anchor: coordinate("Apple", "first"), text: "inserted\n" }
		const replacement: Edit = {
			edit_type: "replace", anchor: coordinate("Apple", "first"), end_anchor: coordinate("Apple", "first"), text: "replaced\n",
		}
		for (const [edit, expected] of [
			[editAtEnd, ["first", "inserted", ""]],
			[replacement, ["replaced", ""]],
		] as const) {
			const { resolvedEdits } = executor.resolveEdits([block([edit])], source, ["Apple"])
			assert.deepEqual(executor.applyEdits(source, resolvedEdits).finalLines, expected)
		}
	})
	it("appends after the empty EOF anchor without adding a blank line", () => {
		const executor = new EditExecutor()
		const source = ["last source line", ""]
		const anchors = ["Apple", "Banana"]
		for (const [text, expected] of [
			["copied block\n", "last source line\ncopied block\n"],
			["copied block", "last source line\ncopied block\n"],
			["\ncopied block\n", "last source line\n\ncopied block\n"],
		] as const) {
			const edit: Edit = { edit_type: "insert_after", anchor: coordinate("Banana", ""), text }
			const { resolvedEdits, failedEdits } = executor.resolveEdits([block([edit])], source, anchors)
			assert.equal(failedEdits.length, 0)
			assert.equal(executor.applyEdits(source, resolvedEdits).finalLines.join("\n"), expected)
		}
	})

	it("rejects simultaneous inserts at the EOF boundary", () => {
		const executor = new EditExecutor()
		const source = ["last source line", ""]
		const anchors = ["Apple", "Banana"]
		for (const other of [
			{ edit_type: "insert_before", anchor: coordinate("Banana", ""), text: "other" },
			{ edit_type: "insert_after", anchor: coordinate("Apple", "last source line"), text: "other" },
		] as Edit[]) {
			const edit: Edit = { edit_type: "insert_after", anchor: coordinate("Banana", ""), text: "copy" }
			const { resolvedEdits, failedEdits } = executor.resolveEdits([block([edit, other])], source, anchors)
			assert.equal(resolvedEdits.length, 0)
			assert.equal(failedEdits.length, 2)
		}
	})



	it("replaces a range before existing content without inserting a blank line", () => {
		const executor = new EditExecutor()
		const edit: Edit = {
			edit_type: "replace", anchor: coordinate("Apple", "first"), end_anchor: coordinate("Banana", ""), text: "replaced\n",
		}
		const { resolvedEdits } = executor.resolveEdits([block([edit])], lines, lineAnchors)
		assert.deepEqual(executor.applyEdits(lines, resolvedEdits).finalLines, ["replaced", "third"])
	})

	it("rejects every edit in an overlapping batch", () => {
		const executor = new EditExecutor()
		const edits: Edit[] = [
			{
				edit_type: "replace",
				anchor: coordinate("Apple", "first"),
				end_anchor: coordinate("Banana", ""),
				text: "left",
			},
			{
				edit_type: "replace",
				anchor: coordinate("Banana", ""),
				end_anchor: coordinate("Cherry", "third"),
				text: "right",
			},
		]

		const result = executor.resolveEdits([block(edits)], lines, lineAnchors)
		assert.equal(result.resolvedEdits.length, 0)
		assert.equal(result.failedEdits.length, 2)
		assert.ok(result.failedEdits.every((failed) => failed.error.includes("Overlaps files edit index")))
	})
})
