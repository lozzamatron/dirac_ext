import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { readFile, rm, stat } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { REPO_ROOT, requestSession, startSession } from "./client.mjs"
import { CREATE_FILE_CONTENT, CREATE_FILE_PATH } from "./fixture-provider.mjs"

const execFileAsync = promisify(execFile)
const harness = path.join(REPO_ROOT, "tests/e2e/cli/harness.mjs")

async function waitForSocketRemoval(session) {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			await stat(path.join(session, "control.sock"))
		} catch (error) {
			if (error.code === "ENOENT") return
			throw error
		}
		await delay(30)
	}
	throw new Error(`Harness did not close its socket: ${session}`)
}

async function stopAndRemove(session) {
	await requestSession(session, { operation: "stop" })
	await waitForSocketRemoval(session)
	// Socket closure starts teardown; wait for the owner to finish before deleting its logs.
	const metadata = JSON.parse(await readFile(path.join(session, "session.json"), "utf8"))
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			process.kill(metadata.pid, 0)
		} catch (error) {
			if (error.code !== "ESRCH") throw error
			await rm(session, { recursive: true })
			return
		}
		await delay(30)
	}
	throw new Error("Harness owner did not exit")
}

const probe =
	'process.stdin.setRawMode(true); console.log("ready"); process.stdin.on("data", d => console.log("received:" + d.toString()));'

test("independent CLI invocations share a private session, recover from invalid requests, and stop", async (context) => {
	const { stdout } = await execFileAsync(process.execPath, [harness, "start", "--", process.execPath, "-e", probe])
	const metadata = JSON.parse(stdout)
	context.after(() => stopAndRemove(metadata.session))
	assert.equal((await stat(metadata.session)).mode & 0o777, 0o700)
	assert.equal((await stat(path.join(metadata.session, "control.sock"))).mode & 0o777, 0o600)
	await requestSession(metadata.session, { operation: "wait", text: "ready" })
	await assert.rejects(requestSession(metadata.session, { operation: "key", key: "invalid" }), /Unsupported key chord/)
	await assert.rejects(requestSession(metadata.session, { operation: "resize", cols: 0, rows: 20 }), /cols must be/)
	await assert.rejects(requestSession(metadata.session, { operation: "unknown" }), /Unknown operation/)
	await assert.rejects(requestSession(metadata.session, { operation: "paste" }), /text must be a string/)
	const result = await execFileAsync(process.execPath, [harness, "write", "--session", metadata.session, "--text", "hello"])
	assert.match(JSON.parse(result.stdout).screen, /received:hello/)
	assert.match(await readFile(path.join(metadata.session, "terminal.ansi"), "utf8"), /received:hello/)
	await assert.rejects(execFileAsync(process.execPath, [harness, "screen"]), /--session is required/)
})

test("idle timeout closes abandoned sessions", async () => {
	const metadata = await startSession({ command: process.execPath, args: ["-e", probe], idleMs: 200 })
	await waitForSocketRemoval(metadata.session)
	await rm(metadata.session, { recursive: true })
})

test("reports startup failures without leaving a terminal owner running", async () => {
	await assert.rejects(startSession({ command: "/does-not-exist/dirac" }), /startup failed/)
	await assert.rejects(startSession({ cols: 0 }), /cols must be/)
})

function inputCursor(snapshot) {
	// Ink hides the hardware cursor and paints its own block with theme.cursorBg.
	const candidates = snapshot.styledRuns.filter((run) => run.bg.value === 0xc6cbdd)
	assert.equal(candidates.length, 1, `Expected one painted composer cursor\n${snapshot.screen}`)
	return candidates[0]
}

function responseLines(snapshot) {
	return snapshot.lines.filter((line) => line.includes("Response line"))
}

for (const fixture of ["long-response", "long-plan"]) {
	for (const [cols, rows] of [
		[100, 30],
		[60, fixture === "long-plan" ? 20 : 30],
	]) {
		test(`#263: new ${fixture} cards start at the beginning (${cols}x${rows})`, { timeout: 60000 }, async (context) => {
			const metadata = await startSession({ fixture, cols, rows })
			context.after(() => stopAndRemove(metadata.session))
			const session = metadata.session
			const prefix = fixture === "long-plan" ? "Plan line" : "Response line"
			const header = fixture === "long-plan" ? "Proposed Plan" : "Task Completed"
			const visibleLines = (snapshot) => snapshot.lines.filter((line) => line.includes(prefix))
			await requestSession(session, { operation: "wait", text: "@ files", timeoutMs: 30000 })
			if (fixture === "long-plan") await requestSession(session, { operation: "key", key: "Tab" })
			await requestSession(session, { operation: "write", text: "Give me a long response." })
			await requestSession(session, { operation: "key", key: "Enter" })
			const initial = await requestSession(session, { operation: "wait", text: header, timeoutMs: 30000 })
			assert.equal(initial.fixtureRequests, 1)
			assert.match(initial.screen, new RegExp(`${prefix} 01`), "A new response must show its beginning without scrolling")
			assert.doesNotMatch(initial.screen, new RegExp(`${prefix} 80`))
			const upAtTop = await requestSession(session, { operation: "key", key: "Up" })
			assert.deepEqual(visibleLines(upAtTop), visibleLines(initial), "Up at the beginning must not move the body")
			const down = await requestSession(session, { operation: "key", key: "Down", count: 4 })
			assert.notDeepEqual(visibleLines(down), visibleLines(initial), "Down must scroll toward later response lines")
			const typed = await requestSession(session, { operation: "write", text: "follow-up" })
			assert.deepEqual(visibleLines(typed), visibleLines(down), "Draft edits must retain the response viewport")
			const top = await requestSession(session, { operation: "key", key: "Up", count: 8 })
			assert.match(top.screen, new RegExp(`${prefix} 01`))
			const resized = await requestSession(session, { operation: "resize", cols: 80, rows: 32 })
			assert.match(resized.screen, new RegExp(`${prefix} 01`), "Resizing at the beginning must retain the first line")
			const bottom = await requestSession(session, { operation: "key", key: "Down", count: 80 })
			assert.match(bottom.screen, new RegExp(`${prefix} 80`), "The end must remain reachable with Down")
			// Width changes remount the composer, so enter the follow-up in the settled UI.
			await requestSession(session, { operation: "key", key: "Ctrl+u" })
			await requestSession(session, { operation: "write", text: "Another long response." })
			await requestSession(session, { operation: "key", key: "Enter" })
			const next = await requestSession(session, { operation: "wait", text: `${prefix} 01`, timeoutMs: 30000 })
			assert.equal(next.fixtureRequests, 2)
			// The previous completion is now printed in scrollback; inspect only the new card.
			const newCard = next.screen.slice(next.screen.lastIndexOf(header))
			assert.match(newCard, new RegExp(`${prefix} 01`))
			assert.doesNotMatch(newCard, new RegExp(`${prefix} 80`), "Follow-up responses must also start at the beginning")
		})
	}
}

for (const [cols, rows] of [[100, 30], [60, 30]]) {
	test(`#265: askDirac completions render Markdown throughout scrolling (${cols}x${rows})`, { timeout: 120000 }, async (context) => {
		const { session } = await startSession({ fixture: "markdown-response", cols, rows })
		context.after(() => stopAndRemove(session))
		await requestSession(session, { operation: "wait", text: "@ files", timeoutMs: 30000 })
		await requestSession(session, { operation: "write", text: "/askDirac what are the auto-approved commands?" })
		await requestSession(session, { operation: "key", key: "Enter" })
		let snapshot = await requestSession(session, { operation: "wait", text: "Task Completed", timeoutMs: 30000 })
		assert.equal(snapshot.fixtureRequests, 1)
		assert.doesNotMatch(snapshot.screen, /## Auto-approved commands/, "Completion headings must not display raw Markdown")
		const seen = new Set()
		for (let step = 0; step < 80; step++) {
			for (const line of snapshot.lines) {
				if (line.includes("Auto-approved commands") && !line.includes("/askDirac")) seen.add("heading")
				if (line.includes("Read-only commands")) {
					assert.doesNotMatch(line, /\*\*/)
					seen.add("bold")
				}
				if (line.includes("Inspect files with")) {
					assert.match(line, /• Inspect files with/)
					assert.doesNotMatch(line, /`/)
					seen.add("list")
				}
				if (line.includes("2. Ask before making changes.")) seen.add("ordered")
				if (line.includes("https://example.com/approvals")) {
					assert.doesNotMatch(line, /\[approvals\]/)
					seen.add("reference")
				}
				if (/Code \d\d:/.test(line)) {
					assert.match(line, /│ echo "Code \d\d: \*\*literal\*\*" /, "Code must retain its border and literal contents off-screen")
					seen.add("code")
				}
				if (line.includes("Approval summary:")) {
					assert.doesNotMatch(line, /\*\*Approval/)
					seen.add("end")
				}
			}
			if (seen.has("end")) break
			snapshot = await requestSession(session, { operation: "key", key: "Down" })
		}
		assert.deepEqual([...seen].sort(), ["bold", "code", "end", "heading", "list", "ordered", "reference"].sort())
		const back = await requestSession(session, { operation: "key", key: "Up", count: 10 })
		assert.match(back.screen, /│ echo "Code \d\d: \*\*literal\*\*" /)
		await requestSession(session, { operation: "resize", cols: 80, rows: 32 })
		await delay(400)
		const resized = await requestSession(session, { operation: "key", key: "Down", count: 18 })
		assert.match(resized.screen, /│ echo "Code \d\d: \*\*literal\*\*" /)
		assert.doesNotMatch(resized.screen, /```/)
	})
}

for (const [cols, rows] of [
	[100, 30],
	[60, 20],
]) {
	test(
		`#264: plan code and prose retain Markdown formatting while scrolling (${cols}x${rows})`,
		{ timeout: 120000 },
		async (context) => {
			const metadata = await startSession({ fixture: "markdown-plan", cols, rows })
			context.after(() => stopAndRemove(metadata.session))
			const session = metadata.session
			await requestSession(session, { operation: "wait", text: "@ files", timeoutMs: 30000 })
			await requestSession(session, { operation: "key", key: "Tab" })
			await requestSession(session, { operation: "write", text: "Create a plan with multiple long code blocks." })
			await requestSession(session, { operation: "key", key: "Enter" })
			const initial = await requestSession(session, { operation: "wait", text: "Markdown plan start.", timeoutMs: 30000 })
			assert.equal(initial.fixtureRequests, 1)
			assert.match(initial.screen, /│ Code 1\.01: \*\*literal\*\* /)
			let snapshot = initial
			let sawProse = false
			for (let step = 0; step < 100; step++) {
				snapshot = await requestSession(session, { operation: "key", key: "Down" })
				for (const line of snapshot.lines.filter((line) => /Code \d\.\d\d/.test(line))) {
					assert.match(
						line,
						/│ Code \d\.\d\d: \*\*literal\*\* /,
						`Code must remain literal when its opening fence is off-screen\n${snapshot.screen}`,
					)
				}
				for (const line of snapshot.lines.filter((line) => line.includes("Prose between blocks"))) {
					sawProse = true
					const body = line.slice(line.indexOf("│") + 2, line.lastIndexOf("│")).trim()
					assert.match(
						body,
						/^Prose between blocks \d and \d\.$/,
						`Prose must be formatted, without a code border or literal markers\n${snapshot.screen}`,
					)
				}
				if (snapshot.screen.includes("Markdown plan end.")) break
			}
			assert.ok(sawProse, "Must scroll across intervening prose")
			assert.match(snapshot.screen, /Markdown plan end\./, "The rendered end must remain reachable")
			const back = await requestSession(session, { operation: "key", key: "Up", count: 10 })
			assert.match(back.screen, /│ Code 3\.\d\d: \*\*literal\*\* /)
			await requestSession(session, { operation: "resize", cols: 80, rows: 24 })
			// Compare the settled UI after App's width-change remount debounce.
			await delay(400)
			// App remounts reset scroll state; re-enter a code block at the new width.
			const resized = await requestSession(session, { operation: "key", key: "Down", count: 8 })
			const codeRows = resized.lines.filter((line) => /Code \d\.\d\d/.test(line))
			assert.ok(codeRows.length > 0)
			assert.doesNotMatch(resized.screen, /Markdown plan start\./)
			for (const line of codeRows) assert.match(line, /│ Code \d\.\d\d: \*\*literal\*\* /)
		},
	)
}

test(
	"#259: the real built CLI navigates a pasted draft before scrolling a canned long response",
	{ timeout: 60000 },
	async (context) => {
		const metadata = await startSession()
		context.after(() => stopAndRemove(metadata.session))
		assert.equal(metadata.fixture, "long-response")
		assert.notEqual(metadata.cwd, REPO_ROOT)
		const session = metadata.session
		await requestSession(session, { operation: "wait", text: "@ files", timeoutMs: 30000 })
		await requestSession(session, { operation: "write", text: "Give me a long response." })
		await requestSession(session, { operation: "key", key: "Enter" })
		await requestSession(session, { operation: "wait", text: "Task Completed", timeoutMs: 30000 })
		await requestSession(session, { operation: "key", key: "Down", count: 80 })
		const completed = await requestSession(session, { operation: "wait", text: "Response line 80", timeoutMs: 30000 })
		assert.equal(completed.fixtureRequests, 1)
		assert.match(completed.screen, /Task Completed/)
		const draft = Array.from({ length: 15 }, (_, index) => `Draft line ${String(index + 1).padStart(2, "0")}`).join("\n")
		const pasted = await requestSession(session, { operation: "paste", text: draft })
		assert.match(pasted.screen, /Draft line 15/)
		assert.doesNotMatch(pasted.screen, /Draft line 01/)
		const endCursor = inputCursor(pasted)
		const up = await requestSession(session, { operation: "key", key: "Up" })
		assert.equal(inputCursor(up).y, endCursor.y - 1, "Up must move into the draft WITHOUT Ctrl+A")
		assert.deepEqual(responseLines(up), responseLines(pasted))
		const down = await requestSession(session, { operation: "key", key: "Down" })
		assert.deepEqual(inputCursor(down), endCursor)
		assert.deepEqual(responseLines(down), responseLines(pasted))

		const top = await requestSession(session, { operation: "key", key: "Up", count: 14 })
		assert.match(top.screen, /Draft line 01/)
		assert.deepEqual(responseLines(top), responseLines(pasted))
		await requestSession(session, { operation: "key", key: "Ctrl+a" })
		const scrolled = await requestSession(session, { operation: "key", key: "Up" })
		assert.notDeepEqual(responseLines(scrolled), responseLines(top), "At the input boundary, Up scrolls the response")
		const insideDraft = await requestSession(session, { operation: "key", key: "Down" })
		assert.deepEqual(responseLines(insideDraft), responseLines(scrolled))
		await requestSession(session, { operation: "key", key: "Ctrl+e" })
		const scrollDown = await requestSession(session, { operation: "key", key: "Down" })
		assert.deepEqual(responseLines(scrollDown), responseLines(pasted))

		const resized = await requestSession(session, { operation: "resize", cols: 80, rows: 24 })
		assert.equal(resized.cols, 80)
		assert.equal(resized.rows, 24)
		assert.match(resized.screen, /Draft line 15/)
		assert.equal(resized.exit, null)

		await requestSession(session, { operation: "key", key: "Ctrl+e" })
		await requestSession(session, { operation: "key", key: "Ctrl+u" })
		const paragraph = Array.from({ length: 120 }, (_, index) => `word${String(index).padStart(3, "0")}`).join(" ")
		const wrapped = await requestSession(session, { operation: "paste", text: paragraph })
		assert.match(wrapped.screen, /word119/)
		assert.doesNotMatch(wrapped.screen, /word000/)
		const wrappedCursor = inputCursor(wrapped)
		const wrappedResponse = responseLines(wrapped)
		const previousRow = await requestSession(session, { operation: "key", key: "Up" })
		assert.equal(inputCursor(previousRow).x, wrappedCursor.x)
		assert.equal(inputCursor(previousRow).y, wrappedCursor.y - 1, "Up must move just one soft-wrapped row")
		assert.deepEqual(responseLines(previousRow), wrappedResponse)
		const nextRow = await requestSession(session, { operation: "key", key: "Down" })
		assert.deepEqual(inputCursor(nextRow), wrappedCursor)
		assert.deepEqual(responseLines(nextRow), wrappedResponse)
		let withinParagraph = await requestSession(session, { operation: "key", key: "Up", count: 10 })
		assert.notDeepEqual(inputCursor(withinParagraph), wrappedCursor)
		assert.deepEqual(responseLines(withinParagraph), wrappedResponse)
		assert.ok(inputCursor(withinParagraph))
		await requestSession(session, { operation: "resize", cols: 100, rows: 30 })
		// Width changes remount the UI after its resize debounce; compare like-sized frames.
		await delay(400)
		const afterResize = await requestSession(session, { operation: "screen" })
		withinParagraph = await requestSession(session, { operation: "key", key: "Up" })
		assert.equal(inputCursor(withinParagraph).x, inputCursor(afterResize).x)
		assert.equal(inputCursor(withinParagraph).y, inputCursor(afterResize).y - 1)
		assert.deepEqual(responseLines(withinParagraph), responseLines(afterResize))
		assert.ok(inputCursor(withinParagraph))

		// Hard/soft breaks, an empty first row, CRLF, and wide graphemes remain editable.
		await requestSession(session, { operation: "key", key: "Ctrl+e" })
		await requestSession(session, { operation: "key", key: "Ctrl+u" })
		const unicode = await requestSession(session, { operation: "paste", text: "\r\n" + "界🙂e\u0301".repeat(60) + "\r\n" })
		const unicodeResponse = responseLines(unicode)
		assert.ok(inputCursor(unicode))
		const unicodeUp = await requestSession(session, { operation: "key", key: "Up" })
		assert.deepEqual(responseLines(unicodeUp), unicodeResponse)
		assert.ok(inputCursor(unicodeUp))
		const unicodeDown = await requestSession(session, { operation: "key", key: "Down" })
		assert.deepEqual(inputCursor(unicodeDown), inputCursor(unicode))
		assert.deepEqual(responseLines(unicodeDown), unicodeResponse)
	},
)
for (const fixture of ["long-plan", "long-response"]) {
	const dimensions =
		fixture === "long-plan"
			? [
				[100, 30],
				[60, 20],
			]
			: [[100, 30]]
	for (const [cols, rows] of dimensions) {
		test(`#262: editing a draft preserves a scrolled ${fixture} (${cols}x${rows})`, { timeout: 60000 }, async (context) => {
			const metadata = await startSession({ fixture, cols, rows })
			context.after(() => stopAndRemove(metadata.session))
			const session = metadata.session
			const linePrefix = fixture === "long-plan" ? "Plan line" : "Response line"
			const visibleLines = (snapshot) => snapshot.lines.filter((line) => line.includes(linePrefix))
			await requestSession(session, { operation: "wait", text: "@ files", timeoutMs: 30000 })
			if (fixture === "long-plan") {
				const mode = await requestSession(session, { operation: "key", key: "Tab" })
				assert.match(mode.screen, /● Plan/)
			}
			await requestSession(session, { operation: "write", text: "Create a long plan." })
			await requestSession(session, { operation: "key", key: "Enter" })
			await requestSession(session, { operation: "wait", text: `${linePrefix} 01`, timeoutMs: 30000 })
			await requestSession(session, { operation: "key", key: "Down", count: 160 })
			const bottom = await requestSession(session, { operation: "wait", text: `${linePrefix} 80`, timeoutMs: 30000 })
			assert.equal(bottom.fixtureRequests, 1)
			assert.match(bottom.screen, fixture === "long-plan" ? /Proposed Plan/ : /Task Completed/)
			const scrolled = await requestSession(session, { operation: "key", key: "Up", count: 8 })
			const expected = visibleLines(scrolled)
			assert.ok(expected.length > 0)
			assert.notDeepEqual(expected, visibleLines(bottom), "Up must actually scroll the displayed body")
			assert.doesNotMatch(scrolled.screen, new RegExp(`${linePrefix} 80`))

			const typed = await requestSession(session, { operation: "write", text: "x" })
			assert.match(typed.screen, /│  x +│/)
			assert.equal(typed.fixtureRequests, 1, "Editing must not submit a response")
			assert.deepEqual(visibleLines(typed), expected, "Typing one character must not jump to the bottom")

			for (const action of [
				{ operation: "write", text: "yz" },
				{ operation: "key", key: "Left" },
				{ operation: "write", text: "m" },
				{ operation: "key", key: "Backspace" },
				{ operation: "key", key: "Delete" },
				{ operation: "key", key: "Ctrl+u" },
				{ operation: "paste", text: "first\r\n界🙂e\u0301\r\nthird" },
				{ operation: "key", key: "Shift+Enter" },
			]) {
				const edited = await requestSession(session, action)
				assert.deepEqual(
					visibleLines(edited),
					expected,
					`Draft edit must retain the body viewport: ${JSON.stringify(action)}`,
				)
				assert.equal(edited.fixtureRequests, 1)
				assert.ok(inputCursor(edited))
			}

			// Width changes remount the UI; compare settled frames at the new dimensions.
			await requestSession(session, { operation: "resize", cols: 80, rows: 24 })
			await delay(400)
			const resized = await requestSession(session, { operation: "screen" })
			const afterResize = await requestSession(session, { operation: "write", text: "r" })
			assert.deepEqual(visibleLines(afterResize), visibleLines(resized))
			assert.ok(inputCursor(afterResize))

			// A newly submitted turn must start its new card at the beginning.
			await requestSession(session, { operation: "key", key: "Ctrl+a" })
			const beforeSubmit = await requestSession(session, { operation: "key", key: "Up", count: 8 })
			assert.doesNotMatch(beforeSubmit.screen, new RegExp(`${linePrefix} 80`))
			await requestSession(session, { operation: "key", key: "Enter" })
			const next = await requestSession(session, { operation: "wait", text: `${linePrefix} 01`, timeoutMs: 30000 })
			assert.equal(next.fixtureRequests, 2)
		})
	}
}
for (const encoding of ["CSI-u", "modifyOtherKeys"]) {
	for (const [cols, rows] of [
		[100, 30],
		[60, 20],
	]) {
		test(
			`#260: Shift+Enter (${encoding}, ${cols}x${rows}) inserts a newline without submitting in the real CLI`,
			{ timeout: 60000 },
			async (context) => {
				const metadata = await startSession({ cols, rows })
				context.after(() => stopAndRemove(metadata.session))
				const session = metadata.session
				const newline = () =>
					requestSession(
						session,
						encoding === "CSI-u"
							? { operation: "key", key: "Shift+Enter" }
							: { operation: "write", text: "\x1b[27;2;13~" },
					)
				await requestSession(session, { operation: "wait", text: "@ files", timeoutMs: 30000 })
				await requestSession(session, { operation: "write", text: "issue260 first line" })
				const afterNewline = await newline()
				assert.equal(afterNewline.fixtureRequests, 0, "Shift+Enter must not start a task")
				assert.equal(
					inputCursor(afterNewline).x,
					3,
					"Shift+Enter must place the painted cursor at the start of a new line",
				)
				const draft = await requestSession(session, { operation: "write", text: "issue260 second line" })
				assert.match(draft.screen, /│  issue260 first line *│\n│  issue260 second line *│/)
				assert.equal(draft.fixtureRequests, 0)

				// Insertion in the middle of a draft must retain the text after the cursor.
				await requestSession(session, { operation: "key", key: "Ctrl+u" })
				await requestSession(session, { operation: "write", text: "leftright" })
				await requestSession(session, { operation: "key", key: "Left", count: 5 })
				await newline()
				const middle = await requestSession(session, { operation: "write", text: "mid" })
				assert.match(middle.screen, /│  left *│\n│  midright *│/)
				assert.equal(middle.fixtureRequests, 0)

				// The existing newline shortcut and normal submit key remain available.
				await requestSession(session, { operation: "key", key: "Ctrl+e" })
				await requestSession(session, { operation: "key", key: "Shift+Down" })
				const third = await requestSession(session, { operation: "write", text: "third" })
				assert.match(third.screen, /│  midright *│\n│  third *│/)
				assert.equal(third.fixtureRequests, 0)
				await requestSession(session, { operation: "key", key: "Enter" })
				const completed = await requestSession(session, { operation: "wait", text: "Task Completed", timeoutMs: 30000 })
				assert.equal(completed.fixtureRequests, 1, "Unmodified Enter must still submit")

				await requestSession(session, { operation: "write", text: "follow-up first" })
				await newline()
				const followUp = await requestSession(session, { operation: "write", text: "follow-up second" })
				assert.match(followUp.screen, /│  follow-up first *│\n│  follow-up second *│/)
				assert.equal(followUp.fixtureRequests, 1, "Shift+Enter must not submit a follow-up")
				assert.deepEqual(responseLines(followUp), responseLines(completed))
			},
		)
	}
}

function assertReadableCreationDescription(snapshot) {
	const rowIndex = snapshot.lines.findIndex((line) => line.includes("Dirac wants to create"))
	assert.notEqual(rowIndex, -1, `Expected a creation description\n${snapshot.screen}`)
	const row = snapshot.lines[rowIndex]
	const leftBorder = row.indexOf("│")
	assert.equal(
		row.indexOf("Dirac wants to create"),
		leftBorder + 2,
		`The description must start at the left of the permission body, not in a diff pane\n${snapshot.screen}`,
	)
	const bodyRows = snapshot.lines.slice(rowIndex, snapshot.lines.findIndex((line) => line.includes("approve")))
	const body = bodyRows.map((line) => line.slice(leftBorder + 2, line.lastIndexOf("│")).trim()).join("")
	assert.ok(body.includes(CREATE_FILE_PATH), `The full path must be readable across wrapped rows\n${snapshot.screen}`)
	assert.ok(!body.includes("…"), `The path must wrap instead of being truncated\n${snapshot.screen}`)
}

for (const [cols, rows] of [
	[180, 40],
	[100, 30],
	[60, 20],
	[40, 24],
]) {
	test(
		`#261: the real CLI left-aligns and wraps create-file permission descriptions (${cols}x${rows})`,
		{ timeout: 60000 },
		async (context) => {
			const metadata = await startSession({ fixture: "create-file", cols, rows })
			context.after(() => stopAndRemove(metadata.session))
			const session = metadata.session
			await requestSession(session, { operation: "wait", text: "@ files", timeoutMs: 30000 })
			await requestSession(session, { operation: "write", text: `Create ${CREATE_FILE_PATH}` })
			await requestSession(session, { operation: "key", key: "Enter" })
			const pending = await requestSession(session, { operation: "wait", text: "Permission Request", timeoutMs: 30000 })
			assert.equal(pending.fixtureRequests, 1)
			assertReadableCreationDescription(pending)
			await assert.rejects(readFile(path.join(metadata.cwd, CREATE_FILE_PATH)), { code: "ENOENT" })
			if (cols === 180) {
				await requestSession(session, { operation: "resize", cols: 60, rows: 20 })
				// App remounts after the width-change debounce; verify like-sized settled frames.
				await delay(400)
				assertReadableCreationDescription(await requestSession(session, { operation: "screen" }))
				await requestSession(session, { operation: "resize", cols, rows })
				await delay(400)
				assertReadableCreationDescription(await requestSession(session, { operation: "screen" }))
			}
			await requestSession(session, { operation: "write", text: "y" })
			const completed = await requestSession(session, {
				operation: "wait",
				text: "File creation fixture completed.",
				timeoutMs: 30000,
			})
			assert.equal(completed.fixtureRequests, 2)
			assert.equal(await readFile(path.join(metadata.cwd, CREATE_FILE_PATH), "utf8"), CREATE_FILE_CONTENT)
		},
	)
}

test("#261: denying file creation still leaves the workspace unchanged", { timeout: 60000 }, async (context) => {
	const metadata = await startSession({ fixture: "create-file", cols: 180, rows: 40 })
	context.after(() => stopAndRemove(metadata.session))
	const session = metadata.session
	await requestSession(session, { operation: "wait", text: "@ files", timeoutMs: 30000 })
	await requestSession(session, { operation: "write", text: `Create ${CREATE_FILE_PATH}` })
	await requestSession(session, { operation: "key", key: "Enter" })
	const pending = await requestSession(session, { operation: "wait", text: "Permission Request", timeoutMs: 30000 })
	assertReadableCreationDescription(pending)
	await requestSession(session, { operation: "write", text: "n" })
	const completed = await requestSession(session, {
		operation: "wait",
		text: "File creation fixture completed.",
		timeoutMs: 30000,
	})
	assert.equal(completed.fixtureRequests, 2)
	await assert.rejects(readFile(path.join(metadata.cwd, CREATE_FILE_PATH)), { code: "ENOENT" })
})
