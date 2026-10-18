import { describe, expect, it } from "vitest"
import stringWidth from "string-width"
import { clipDiffRows, createDiffLayout } from "./diff-layout"

const patch = [
	"Index: test.txt",
	"--- test.txt",
	"+++ test.txt",
	"@@ -10,3 +10,4 @@",
	" before",
	"-old",
	"+new one",
	"+new two",
	" after",
	"@@ -30,1 +31,2 @@",
	" tail",
	"+last",
].join("\n")

describe("formatted diff row layout", () => {
	it("pairs replacement lines and counts hunk separators for split layout", () => {
		const layout = createDiffLayout(patch, 100)
		expect(layout.split).toBe(true)
		expect(layout.rows).toHaveLength(7)
		expect(layout.rows[1]).toMatchObject({
			type: "split",
			oldLine: { content: "old", oldLineNumber: 11 },
			newLine: { content: "new one", newLineNumber: 11 },
		})
		expect(layout.rows[2]).toMatchObject({ type: "split", newLine: { content: "new two", newLineNumber: 12 } })
		expect(layout.rows[4]).toEqual({ type: "separator" })
	})

	it.each([100, 50])("clips complete formatted rows without re-parsing or changing line numbers at width %i", (width) => {
		const { rows } = createDiffLayout(patch, width)
		const top = clipDiffRows(rows, 3, rows.length)
		expect(top).toEqual(rows.slice(0, 3))
		expect(clipDiffRows(rows, 3, rows.length - 4)).toEqual(rows.slice(1, 4))
		expect(clipDiffRows(rows, 3, 0)).toEqual(rows.slice(-3))
		expect(clipDiffRows(rows, 3, -10)).toEqual(rows.slice(-3))
	})

	it("counts wrapped Unicode terminal rows in unified mode, including their gutter and prefix", () => {
		const width = 20
		const layout = createDiffLayout("@@ -99 +99 @@\n-old\n+" + "界🙂é ".repeat(13), width)
		expect(layout.split).toBe(false)
		const added = layout.rows.filter((row) => row.type === "line" && row.line.type === "add")
		expect(added.length).toBeGreaterThan(3)
		for (const row of added) {
			if (row.type !== "line") throw new Error("Expected unified line")
			expect(stringWidth(row.line.content)).toBeLessThanOrEqual(width - layout.gutterWidth - 6)
		}
		expect(added[0]).toMatchObject({ continuation: false, line: { newLineNumber: 99 } })
		expect(added[1]).toMatchObject({ continuation: true })
	})

	it.each([
		"<<<<<<< SEARCH:10\nbefore\nold\nafter\n=======\nbefore\nnew\nafter\n>>>>>>> REPLACE",
		"*** Begin Patch\n*** Update File: test.txt\n@@\n before\n-old\n+new\n after\n*** End Patch",
		"@@ -10,3 +10,3 @@\n before\n-old\n+new\n after",
	])("preserves existing patch formats", (content) => {
		const layout = createDiffLayout(content, 100)
		expect(layout.rows).toHaveLength(3)
		expect(layout.rows[1]).toMatchObject({ type: "split", oldLine: { content: "old" }, newLine: { content: "new" } })
	})

	it("includes collapsed-context rows in the scroll extent", () => {
		const content = `@@ -1,20 +1,21 @@\n${Array.from({ length: 20 }, (_, index) => ` context ${index}`).join("\n")}\n+added`
		const layout = createDiffLayout(content, 100)
		expect(layout.rows).toHaveLength(4)
		expect(layout.rows[0]).toEqual({ type: "collapsed", count: 18 })
	})
})
