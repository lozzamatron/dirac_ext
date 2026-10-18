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

function composer(snapshot) {
	const top = snapshot.lines.findLastIndex((line) => line.startsWith("╭"))
	const bottom = snapshot.lines.findLastIndex((line) => line.startsWith("╰"))
	return snapshot.lines.slice(top + 1, bottom).join("\n")
}

function currentResponseLines(snapshot) {
	const header = snapshot.lines.findLastIndex((line) => line.includes("Task Completed"))
	assert.ok(header >= 0, snapshot.screen)
	return snapshot.lines.slice(header).filter((line) => line.includes("Response line"))
}

function inputCursor(snapshot) {
	const top = snapshot.lines.findLastIndex((line) => line.startsWith("╭"))
	const bottom = snapshot.lines.findLastIndex((line) => line.startsWith("╰"))
	const cursors = snapshot.styledRuns.filter((run) => run.bg.value === 0xc6cbdd && run.y > top && run.y < bottom)
	assert.equal(cursors.length, 1, snapshot.screen)
	return { x: cursors[0].x, y: cursors[0].y - top, text: cursors[0].text }
}

async function submit(session, text, requests) {
	await requestSession(session, { operation: "write", text })
	await requestSession(session, { operation: "key", key: "Enter" })
	const snapshot = await requestSession(session, { operation: "wait", text: "Task Completed", timeoutMs: 30000 })
	assert.equal(snapshot.fixtureRequests, requests)
	return snapshot
}

test(
	"#269: Ctrl+arrows recall submitted prompts without sending and restore the draft cursor",
	{ timeout: 60000 },
	async (context) => {
		const { session } = await startSession({ cols: 100, rows: 30 })
		context.after(() => stopAndRemove(session))
		await requestSession(session, { operation: "wait", text: "@ files", timeoutMs: 30000 })
		await submit(session, "Recall this initial prompt", 1)
		await requestSession(session, { operation: "write", text: "Keep my draft" })
		const draft = await requestSession(session, { operation: "key", key: "Left", count: 3 })
		const recalled = await requestSession(session, { operation: "key", key: "Ctrl+Up" })
		assert.match(composer(recalled), /Recall this initial prompt/, recalled.screen)
		assert.match(recalled.screen, /Ctrl\+↑\/↓ previous prompts/, "The muted shortcut hint belongs beneath the input")
		assert.equal(recalled.fixtureRequests, 1, "Recall must not send a request")
		const restored = await requestSession(session, { operation: "key", key: "Ctrl+Down" })
		assert.match(composer(restored), /Keep my draft/)
		assert.deepEqual(inputCursor(restored), inputCursor(draft), "Restore the original draft cursor, not just its text")
		assert.equal(restored.fixtureRequests, 1)
	},
)
for (const options of [
	{ cols: 60, rows: 20 },
	{ cols: 80, rows: 24, vimMode: true },
]) {
	test(
		`#269: follow-up recall, editing, scrolling, and completion priority (${JSON.stringify(options)})`,
		{ timeout: 60000 },
		async (context) => {
			const { session } = await startSession(options)
			context.after(() => stopAndRemove(session))
			await requestSession(session, { operation: "wait", text: "@ files", timeoutMs: 30000 })
			await submit(session, "first submitted prompt", 1)
			await requestSession(session, { operation: "paste", text: "follow-up 😀\nsecond line" })
			await requestSession(session, { operation: "key", key: "Enter" })
			await requestSession(session, { operation: "wait", text: "Task Completed", timeoutMs: 30000 })
			const scrolled = await requestSession(session, { operation: "key", key: "Down" })
			if (options.vimMode) await requestSession(session, { operation: "key", key: "Escape" })
			const recalled = await requestSession(session, { operation: "key", key: "Ctrl+Up" })
			assert.match(composer(recalled), /follow-up 😀/)
			assert.match(composer(recalled), /second line/)
			assert.equal(recalled.fixtureRequests, 2)
			assert.deepEqual(
				currentResponseLines(recalled),
				currentResponseLines(scrolled),
				"Recall must not scroll the response",
			)
			if (options.vimMode) {
				assert.match(recalled.screen, /NORMAL/)
				await requestSession(session, { operation: "write", text: "A" })
			}
			await requestSession(session, { operation: "write", text: " edited" })
			await requestSession(session, { operation: "key", key: "Enter" })
			const completed = await requestSession(session, { operation: "wait", text: "Task Completed", timeoutMs: 30000 })
			assert.equal(completed.fixtureRequests, 3)
			await requestSession(session, { operation: "write", text: "/sett" })
			const menu = await requestSession(session, { operation: "wait", text: "❯ /settings" })
			const replaced = await requestSession(session, { operation: "key", key: "Ctrl+Up" })
			assert.match(composer(replaced), /second line edited/)
			assert.doesNotMatch(composer(replaced), /\/sett/)
			assert.equal(replaced.fixtureRequests, 3)
			await requestSession(session, { operation: "key", key: "Ctrl+Down" })
			const restored = await requestSession(session, { operation: "wait", text: "/sett" })
			assert.match(composer(restored), /\/sett/)
			assert.deepEqual(inputCursor(restored), inputCursor(menu))
			if (options.cols < 64) assert.match(restored.screen, /Ctrl\+↑\/↓ history/)
		},
	)
}

test("#269: recalled text survives clearing, relaunching, and workspace isolation", { timeout: 60000 }, async (context) => {
	const metadata = await startSession({ cols: 100, rows: 30 })
	const session = metadata.session
	context.after(() => stopAndRemove(session))
	await requestSession(session, { operation: "wait", text: "@ files", timeoutMs: 30000 })
	await submit(session, "old conversation initial", 1)
	await submit(session, "old conversation follow-up", 2)
	await requestSession(session, { operation: "write", text: "/clear" })
	await requestSession(session, { operation: "key", key: "Enter" })
	let recalled = await requestSession(session, { operation: "key", key: "Ctrl+Up" })
	assert.match(composer(recalled), /old conversation follow-up/)
	recalled = await requestSession(session, { operation: "key", key: "Ctrl+Up" })
	assert.match(composer(recalled), /old conversation initial/)
	const restored = await requestSession(session, { operation: "key", key: "Ctrl+Down", count: 2 })
	assert.match(composer(restored), /^│\s+│$/m)
	const args = [path.resolve("cli/dist/cli.mjs"), "--no-index", "--config", path.join(session, "home"), "--act"]
	for (const sameWorkspace of [true, false]) {
		const { session: restarted } = await startSession({
			command: process.execPath,
			args,
			...(sameWorkspace ? { cwd: metadata.cwd } : {}),
			cols: 100,
			rows: 30,
		})
		context.after(() => stopAndRemove(restarted))
		await requestSession(restarted, { operation: "wait", text: "@ files", timeoutMs: 30000 })
		const snapshot = await requestSession(restarted, { operation: "key", key: "Ctrl+Up" })
		if (sameWorkspace) assert.match(composer(snapshot), /old conversation follow-up/, snapshot.screen)
		else assert.doesNotMatch(composer(snapshot), /old conversation/)
		assert.equal(snapshot.fixtureRequests, null, "Relaunch recall doesn't need a provider")
	}
})

test("#269: browsing restores large paste contents, cursor, and resize retention", { timeout: 60000 }, async (context) => {
	const { session } = await startSession({ cols: 100, rows: 30 })
	context.after(() => stopAndRemove(session))
	await requestSession(session, { operation: "wait", text: "@ files", timeoutMs: 30000 })
	await submit(session, "small original prompt", 1)
	const longText = "Preserved pasted content\n".repeat(500)
	const pasted = await requestSession(session, { operation: "paste", text: longText })
	// PTY chunk sizes vary: large input can arrive as a collapsed paste or ordinary multiline text.
	assert.match(composer(pasted), /\[Pasted text #1|Preserved pasted content/)
	const draft = await requestSession(session, { operation: "key", key: "Left", count: 2 })
	await requestSession(session, { operation: "key", key: "Ctrl+Up" })
	const restored = await requestSession(session, { operation: "key", key: "Ctrl+Down" })
	assert.equal(composer(restored), composer(draft))
	assert.deepEqual(inputCursor(restored), inputCursor(draft))
	const resized = await requestSession(session, { operation: "resize", cols: 60, rows: 24 })
	assert.match(composer(resized), /\[Pasted text #1|Preserved pasted content/)
	await requestSession(session, { operation: "key", key: "Enter" })
	const completed = await requestSession(session, { operation: "wait", text: "Task Completed", timeoutMs: 30000 })
	assert.equal(completed.fixtureRequests, 2)
	await requestSession(session, { operation: "key", key: "Ctrl+Up" })
	const recalled = await requestSession(session, { operation: "key", key: "Home" })
	assert.match(composer(recalled), /Preserved pasted content/)
	assert.doesNotMatch(composer(recalled), /\[Pasted text/)
	assert.equal(recalled.fixtureRequests, 2)
})
