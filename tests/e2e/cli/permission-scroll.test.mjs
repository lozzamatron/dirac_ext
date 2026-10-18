import assert from "node:assert/strict"
import { readFile, rm } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { requestSession, startSession } from "./client.mjs"
import { EDIT_FILE_CONTENT, EDIT_FILE_INSERTIONS, EDIT_FILE_PATH } from "./fixture-provider.mjs"

async function stopAndRemove(metadata) {
	await requestSession(metadata.session, { operation: "stop" })
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			process.kill(metadata.pid, 0)
		} catch (error) {
			if (error.code !== "ESRCH") throw error
			await rm(metadata.session, { recursive: true })
			return
		}
		await delay(30)
	}
	throw new Error("Harness owner did not exit")
}

function diffRows(snapshot) {
	return snapshot.lines.filter((line) => /Context line|Added \d\.\d|fixture\.|unchanged lines|│\s+─{5,}/.test(line)).map((line) => line.trim())
}

async function openEditPermission(metadata) {
	const session = metadata.session
	await requestSession(session, { operation: "wait", text: "@ files", timeoutMs: 30000 })
	await requestSession(session, { operation: "write", text: "Make the two insertions in permission-scroll.txt." })
	await requestSession(session, { operation: "key", key: "Enter" })
	const initial = await requestSession(session, { operation: "wait", text: "Apply 2 edit", timeoutMs: 30000 })
	assert.equal(initial.fixtureRequests, 2, "The real read_file and edit_file tools must run")
	assert.match(initial.screen, /Added 1\.01/)
	assert.match(initial.screen, /approve/)
	assert.match(initial.screen, /deny/)
	assert.equal(await readFile(path.join(metadata.cwd, EDIT_FILE_PATH), "utf8"), EDIT_FILE_CONTENT)
	return initial
}

test("#266: Up moves the file-edit diff instead of cutting rows from its bottom", { timeout: 60000 }, async (context) => {
	const metadata = await startSession({ fixture: "edit-file", cols: 180, rows: 32 })
	context.after(() => stopAndRemove(metadata))
	await openEditPermission(metadata)
	const down = await requestSession(metadata.session, { operation: "key", key: "Down", count: 25 })
	const up5 = await requestSession(metadata.session, { operation: "key", key: "Up", count: 5 })
	assert.notEqual(diffRows(up5)[0], diffRows(down)[0], "Up must move the first visible diff row, not just shorten the hunk")
	assert.ok(diffRows(up5).length >= diffRows(down).length, "Scrolling up must retain a full viewport")
	assert.deepEqual(diffRows(up5).slice(5), diffRows(down).slice(0, -5), "All formatted rows, including hunk separators, must move together")
	assert.match(up5.screen, /Added 1\.18/, "Earlier rows from the previous hunk must re-enter the viewport")
	const up8 = await requestSession(metadata.session, { operation: "key", key: "Up", count: 3 })
	assert.match(up8.screen, /Added 1\.15/)
	assert.notEqual(diffRows(up8)[0], diffRows(up5)[0])
	const returnDown = await requestSession(metadata.session, { operation: "key", key: "Down", count: 8 })
	assert.deepEqual(diffRows(returnDown), diffRows(down), "Down must restore the exact same rendered rows")
	const bottom = await requestSession(metadata.session, { operation: "key", key: "Down", count: 100 })
	assert.match(bottom.screen, /Added 2\.28/)
	assert.match(bottom.screen, /Context line 37/)
	const atBottom = await requestSession(metadata.session, { operation: "key", key: "Down", count: 3 })
	assert.deepEqual(diffRows(atBottom), diffRows(bottom))
	const top = await requestSession(metadata.session, { operation: "key", key: "Up", count: 100 })
	assert.match(top.screen, /Added 1\.01/)
	await requestSession(metadata.session, { operation: "write", text: "n" })
	await requestSession(metadata.session, { operation: "wait", text: "File edit fixture completed.", timeoutMs: 30000 })
	assert.equal(
		await readFile(path.join(metadata.cwd, EDIT_FILE_PATH), "utf8"),
		EDIT_FILE_CONTENT,
		"Denial must preserve the file",
	)
})
for (const [cols, rows] of [
	[100, 30],
	[60, 24],
]) {
	test(`#266: unified diff scrolling, resizing and approval (${cols}x${rows})`, { timeout: 60000 }, async (context) => {
		const metadata = await startSession({ fixture: "edit-file", cols, rows })
		context.after(() => stopAndRemove(metadata))
		await openEditPermission(metadata)
		const down = await requestSession(metadata.session, { operation: "key", key: "Down", count: 25 })
		const up = await requestSession(metadata.session, { operation: "key", key: "Up", count: 5 })
		assert.notDeepEqual(diffRows(up), diffRows(down))
		const restored = await requestSession(metadata.session, { operation: "key", key: "Down", count: 5 })
		assert.deepEqual(diffRows(restored), diffRows(down))
		await requestSession(metadata.session, { operation: "resize", cols: 180, rows: 32 })
		const wideTop = await requestSession(metadata.session, { operation: "key", key: "Up", count: 100 })
		assert.match(wideTop.screen, /Added 1\.01/)
		const wideBottom = await requestSession(metadata.session, { operation: "key", key: "Down", count: 100 })
		assert.match(wideBottom.screen, /Added 2\.28/)
		await requestSession(metadata.session, { operation: "resize", cols, rows })
		const narrowBottom = await requestSession(metadata.session, { operation: "key", key: "Down", count: 100 })
		assert.match(narrowBottom.screen, /Added 2\.28/)
		const clamped = await requestSession(metadata.session, { operation: "key", key: "Down", count: 3 })
		assert.deepEqual(diffRows(clamped), diffRows(narrowBottom))
		await requestSession(metadata.session, { operation: "write", text: "y" })
		await requestSession(metadata.session, { operation: "wait", text: "File edit fixture completed.", timeoutMs: 30000 })
		const expected = EDIT_FILE_CONTENT.replace(
			"Context line 05.\n",
			`Context line 05.\n${EDIT_FILE_INSERTIONS[0]}\n`,
		).replace("Context line 35.\n", `Context line 35.\n${EDIT_FILE_INSERTIONS[1]}\n`)
		assert.equal(
			await readFile(path.join(metadata.cwd, EDIT_FILE_PATH), "utf8"),
			expected,
			"Approval must apply both edits exactly",
		)
	})
}
