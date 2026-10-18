import assert from "node:assert/strict"
import { readFile, rm } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { requestSession, startSession } from "./client.mjs"

async function stopAndRemove(session) {
	await requestSession(session, { operation: "stop" })
	const { pid } = JSON.parse(await readFile(path.join(session, "session.json"), "utf8"))
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			process.kill(pid, 0)
		} catch (error) {
			if (error.code !== "ESRCH") throw error
			await rm(session, { recursive: true })
			return
		}
		await delay(30)
	}
	throw new Error("Harness owner did not exit")
}

function inputCursor(snapshot) {
	// Resizing the welcome screen can leave old cells above the current composer.
	const top = snapshot.lines.findLastIndex((line) => line.startsWith("╭"))
	const bottom = snapshot.lines.findLastIndex((line) => line.startsWith("╰"))
	const cursors = snapshot.styledRuns.filter((run) => run.bg.value === 0xc6cbdd && run.y > top && run.y < bottom)
	assert.equal(cursors.length, 1, snapshot.screen)
	return cursors[0]
}

async function start(context, options = {}) {
	const { session } = await startSession({ cols: 80, rows: 24, vimMode: true, ...options })
	context.after(() => stopAndRemove(session))
	await requestSession(session, {
		operation: "wait",
		text: options.vimMode === false ? "/ commands" : "INSERT",
		timeoutMs: 30000,
	})
	return session
}

for (const dimensions of [
	{ cols: 100, rows: 30 },
	{ cols: 80, rows: 24 },
	{ cols: 40, rows: 20 },
]) {
	test(
		`#92: Esc, counted word movement, delete to line end, and insert (${dimensions.cols}x${dimensions.rows})`,
		{ timeout: 60000 },
		async (context) => {
			const session = await start(context, dimensions)
			await requestSession(session, { operation: "write", text: "one two three four" })
			await requestSession(session, { operation: "key", key: "Escape" })
			const moved = await requestSession(session, { operation: "write", text: "3b" })
			assert.doesNotMatch(moved.screen, /four3b/, "Normal-mode commands must not be inserted into the draft")
			assert.equal(
				inputCursor(moved).text,
				"t",
				"3b from the last character must move to 'two' (including the current word start)",
			)
			const deleted = await requestSession(session, { operation: "write", text: "d$" })
			assert.doesNotMatch(deleted.screen, /one two three four/)
			assert.match(deleted.screen, /│  one /)
			assert.doesNotMatch(deleted.screen, /two three four/)
			assert.equal(deleted.fixtureRequests, 0, "Editing must not submit a request")
			await requestSession(session, { operation: "write", text: "i" })
			const inserted = await requestSession(session, { operation: "write", text: "replacement" })
			assert.match(inserted.screen, /replacement/)
			assert.doesNotMatch(inserted.screen, /ireplacement/)
			await requestSession(session, { operation: "key", key: "Enter" })
			const completed = await requestSession(session, { operation: "wait", text: "Task Completed", timeoutMs: 30000 })
			assert.equal(completed.fixtureRequests, 1)
		},
	)
}

async function openVimSetting(session) {
	await requestSession(session, { operation: "write", text: "/settings" })
	await requestSession(session, { operation: "key", key: "Enter" })
	await requestSession(session, { operation: "write", text: "/" })
	// The existing settings search accepts individual typed keys, not a pasted chunk.
	for (const text of "vim") await requestSession(session, { operation: "write", text })
	await requestSession(session, { operation: "wait", text: "Vim prompt editing" })
	await requestSession(session, { operation: "key", key: "Enter" })
}

async function closeSettings(session) {
	await requestSession(session, { operation: "key", key: "Escape", count: 2 })
	return await requestSession(session, { operation: "wait", text: "@ files" })
}

test(
	"#92: opt-in setting applies immediately, persists across launches, and disables cleanly",
	{ timeout: 60000 },
	async (context) => {
		const session = await start(context, { vimMode: false })
		await requestSession(session, { operation: "write", text: "draft" })
		await requestSession(session, { operation: "key", key: "Escape" })
		const plain = await requestSession(session, { operation: "write", text: "3bd$" })
		assert.match(plain.screen, /draft3bd\$/)
		assert.doesNotMatch(plain.screen, /NORMAL|INSERT/)
		await requestSession(session, { operation: "key", key: "Ctrl+u" })
		await openVimSetting(session)
		await requestSession(session, { operation: "key", key: "Enter" })
		assert.match((await closeSettings(session)).screen, /INSERT/)
		const home = path.join(session, "home")
		assert.equal(JSON.parse(await readFile(path.join(home, "data/globalState.json"), "utf8")).cliVimMode, true)
		const { session: restarted } = await startSession({
			cols: 80,
			rows: 24,
			command: process.execPath,
			args: [path.resolve("cli/dist/cli.mjs"), "--no-index", "--config", home, "--act"],
		})
		context.after(() => stopAndRemove(restarted))
		await requestSession(restarted, { operation: "wait", text: "INSERT", timeoutMs: 30000 })
		await requestSession(restarted, { operation: "write", text: "abc" })
		const normal = await requestSession(restarted, { operation: "key", key: "Escape" })
		assert.match(normal.screen, /NORMAL/)
		assert.equal(inputCursor(normal).text, "c")
		await requestSession(session, { operation: "write", text: "abc" })
		await requestSession(session, { operation: "key", key: "Escape" })
		await requestSession(session, { operation: "write", text: "0C" })
		await openVimSetting(session)
		await requestSession(session, { operation: "key", key: "Enter" })
		assert.doesNotMatch((await closeSettings(session)).screen, /NORMAL|INSERT/)
		assert.equal(JSON.parse(await readFile(path.join(home, "data/globalState.json"), "utf8")).cliVimMode, false)
		const disabled = await requestSession(session, { operation: "write", text: "i3bd$" })
		assert.match(disabled.screen, /i3bd\$/)
		assert.equal(disabled.fixtureRequests, 0)
	},
)

test(
	"#92: multiline CRLF/Unicode, painted cursor, raw editing keys, undo, resize and follow-up",
	{ timeout: 60000 },
	async (context) => {
		const session = await start(context)
		// Exercise resizing in the conversation, not the independently overflowing welcome art.
		await requestSession(session, { operation: "write", text: "Start a conversation." })
		await requestSession(session, { operation: "key", key: "Enter" })
		await requestSession(session, { operation: "wait", text: "Task Completed", timeoutMs: 30000 })
		await requestSession(session, { operation: "paste", text: "first 😀\r\nsecond é界\r\nthird" })
		await requestSession(session, { operation: "key", key: "Escape" })
		const emoji = await requestSession(session, { operation: "write", text: "ggw" })
		assert.equal(inputCursor(emoji).text, "😀")
		const removed = await requestSession(session, { operation: "write", text: "x" })
		assert.doesNotMatch(removed.screen, /😀/)
		const restored = await requestSession(session, { operation: "write", text: "u" })
		assert.match(restored.screen, /first 😀/)
		const last = await requestSession(session, { operation: "write", text: "j$" })
		assert.equal(inputCursor(last).text, "界")
		const resized = await requestSession(session, { operation: "resize", cols: 40, rows: 20 })
		assert.match(resized.screen, /NORMAL/)
		assert.equal(inputCursor(resized).text, "界")
		const back = await requestSession(session, { operation: "key", key: "Backspace" })
		assert.match(back.screen, /second é界/)
		const deleted = await requestSession(session, { operation: "key", key: "Delete" })
		assert.match(deleted.screen, /second 界/)
		assert.doesNotMatch(deleted.screen, /é/)
		const undone = await requestSession(session, { operation: "write", text: "u" })
		assert.match(undone.screen, /second é界/)
		const redone = await requestSession(session, { operation: "key", key: "Ctrl+r" })
		assert.match(redone.screen, /second 界/)
		assert.equal(redone.fixtureRequests, 1)
		await requestSession(session, { operation: "key", key: "Home" })
		assert.equal(inputCursor(await requestSession(session, { operation: "key", key: "End" })).text, "界")
		await requestSession(session, { operation: "key", key: "Enter" })
		const completed = await requestSession(session, { operation: "wait", text: "Task Completed", timeoutMs: 30000 })
		assert.equal(completed.fixtureRequests, 2)
		assert.match(completed.screen, /INSERT/)
		await requestSession(session, { operation: "write", text: "follow-up" })
		const newline = await requestSession(session, { operation: "key", key: "Shift+Enter" })
		assert.equal(newline.fixtureRequests, 2)
		assert.match(newline.screen, /follow-up/)
		await requestSession(session, { operation: "write", text: "second line" })
		await requestSession(session, { operation: "key", key: "Enter" })
		const next = await requestSession(session, { operation: "wait", text: "Response line 01", timeoutMs: 30000 })
		assert.equal(next.fixtureRequests, 3)
	},
)

test("#92: INSERT completion menus, Escape cancellation, changes, and wrapped prompt", { timeout: 60000 }, async (context) => {
	const session = await start(context, { cols: 40, rows: 20 })
	await requestSession(session, { operation: "write", text: "/sett" })
	await requestSession(session, { operation: "wait", text: "❯ /settings" })
	const escaped = await requestSession(session, { operation: "key", key: "Escape" })
	assert.match(escaped.screen, /NORMAL/)
	assert.doesNotMatch(escaped.screen, /❯ \/settings/)
	await requestSession(session, { operation: "write", text: "0C" })
	await requestSession(session, { operation: "paste", text: "word ".repeat(24) })
	await requestSession(session, { operation: "key", key: "Escape" })
	const atStart = await requestSession(session, { operation: "write", text: "0" })
	assert.equal(inputCursor(atStart).text, "w")
	await requestSession(session, { operation: "write", text: "2cw" })
	const changed = await requestSession(session, { operation: "write", text: "new" })
	assert.match(changed.screen, /new word/)
	assert.match(changed.screen, /INSERT/)
	await requestSession(session, { operation: "key", key: "Escape" })
	await requestSession(session, { operation: "write", text: "u" })
	const incomplete = await requestSession(session, { operation: "write", text: "d" })
	await requestSession(session, { operation: "key", key: "Escape" })
	const cancelled = await requestSession(session, { operation: "write", text: "w" })
	assert.match(cancelled.screen, /word word/)
	assert.equal(cancelled.fixtureRequests, 0)
	assert.equal(inputCursor(cancelled).text, "w")
	assert.notDeepEqual(inputCursor(cancelled), inputCursor(incomplete))
})

for (const [name, action] of [
	["CSI-u Shift+Enter", { operation: "write", text: "\x1b[13;2u" }],
	["modifyOtherKeys Shift+Enter", { operation: "write", text: "\x1b[27;2;13~" }],
	["Shift+Down", { operation: "key", key: "Shift+Down" }],
]) {
	test(`#92: ${name} inserts a newline even in NORMAL`, { timeout: 60000 }, async (context) => {
		const session = await start(context)
		await requestSession(session, { operation: "write", text: "normal newline" })
		await requestSession(session, { operation: "key", key: "Escape" })
		const newline = await requestSession(session, action)
		assert.equal(newline.fixtureRequests, 0)
		assert.match(newline.screen, /│  normal newlin/)
		assert.match(newline.screen, /│  e /)
		assert.match(newline.screen, /NORMAL/)
	})
}
