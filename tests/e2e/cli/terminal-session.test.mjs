import assert from "node:assert/strict"
import { test } from "node:test"
import { REPO_ROOT } from "./client.mjs"
import { encodeKey, TerminalSession } from "./terminal-session.mjs"

const probe = String.raw`
process.stdin.setRawMode(true);
process.stdout.write('\x1b[2J\x1b[Hprobe ready\r\n');
process.stdin.on('data', data => {
  const text = data.toString();
  if (text === 'enable-bracket') process.stdout.write('\x1b[?2004h');
  process.stdout.write('input:' + JSON.stringify(text) + '\r\n');
});
process.stdout.on('resize', () => process.stdout.write('size:' + process.stdout.columns + 'x' + process.stdout.rows + '\r\n'));
`

function createProbe(context, program = probe) {
	const terminal = new TerminalSession({
		command: process.execPath,
		args: ["-e", program],
		cwd: REPO_ROOT,
		env: process.env,
		cols: 80,
		rows: 24,
	})
	context.after(() => terminal.stop())
	return terminal
}

test("encodes terminal key chords and rejects unsupported combinations", () => {
	assert.equal(encodeKey("Up"), "\x1b[A")
	assert.equal(encodeKey("Shift+Down"), "\x1b[1;2B")
	assert.equal(encodeKey("Shift+Enter"), "\x1b[13;2u")
	assert.equal(encodeKey("Enter"), "\r")
	assert.equal(encodeKey("Alt+Left"), "\x1b[1;3D")
	assert.equal(encodeKey("Ctrl+a"), "\x01")
	assert.equal(encodeKey("Ctrl+e"), "\x05")
	assert.equal(encodeKey("Shift+Tab"), "\x1b[Z")
	assert.equal(encodeKey("Delete"), "\x1b[3~")
	assert.throws(() => encodeKey("Command+Up"), /Unknown key chord/)
	assert.throws(() => encodeKey("Ctrl+Enter"), /Unsupported key chord/)
})

test("writes multiline paste as one input, respecting negotiated bracketed-paste mode", async (context) => {
	const terminal = createProbe(context)
	await terminal.waitForText("probe ready")
	assert.equal(terminal.terminal.modes.bracketedPasteMode, false)
	terminal.paste("first\nsecond")
	await terminal.waitForText('input:"first\\nsecond"')
	terminal.write("enable-bracket")
	await terminal.waitForText('input:"enable-bracket"')
	assert.equal(terminal.terminal.modes.bracketedPasteMode, true)
	terminal.paste("third\nfourth")
	await terminal.waitForText('input:"\\u001b[200~third\\nfourth\\u001b[201~"')
	assert.throws(() => terminal.paste(undefined), /text must be a string/)
})

test("sends repeated keys separately, resizes the PTY, and reports wait failures", async (context) => {
	const terminal = createProbe(context)
	await terminal.waitForText("probe ready")
	await terminal.press("Up", 3)
	assert.equal(terminal.snapshot().screen.match(/input:"\\u001b\[A"/g)?.length, 3)
	terminal.resize(60, 20)
	await terminal.waitForText("size:60x20")
	assert.equal(terminal.snapshot().cols, 60)
	assert.equal(terminal.snapshot().rows, 20)
	await assert.rejects(terminal.waitForText("not on screen", 100), /Timed out waiting.*not on screen/)
	assert.throws(() => terminal.resize(0, 20), /cols must be/)
	await assert.rejects(terminal.press("Up", -1), /count must be/)
})

test("emulates ANSI cursor movement and compact styled runs instead of stripping escape codes", async (context) => {
	const terminal = createProbe(
		context,
		`process.stdout.write('\x1b[2J\x1b[4;6H\x1b[48;2;198;203;221mX\x1b[0m\x1b[2;3Hready'); setInterval(() => {}, 1000);`,
	)
	const snapshot = await terminal.waitForText("ready")
	assert.equal(snapshot.lines[3].slice(5, 6), "X")
	assert.deepEqual(snapshot.cursor, { x: 7, y: 1, baseY: 0 })
	assert.equal(snapshot.styledRuns.length, 1)
	assert.equal(snapshot.styledRuns[0].bg.value, 0xc6cbdd)
	assert.equal(snapshot.styledRuns[0].x, 5)
	assert.equal(snapshot.styledRuns[0].y, 3)
	assert.ok(terminal.snapshot({ scrollback: true }).scrollback.length >= 24)
})

test("retains the final screen after process exit and refuses further input", async (context) => {
	const terminal = createProbe(context, 'process.stdout.write("finished\\n"); process.exitCode = 7;')
	await terminal.exited
	await terminal.settle()
	assert.equal(terminal.snapshot().exit.exitCode, 7)
	assert.match(terminal.snapshot().screen, /finished/)
	assert.throws(() => terminal.write("ignored"), /Terminal process exited/)
	await assert.rejects(terminal.waitForText("missing"), /Process exited before displaying/)
})

test("stops a process that ignores SIGTERM", async () => {
	const terminal = new TerminalSession({
		command: process.execPath,
		args: ["-e", 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'],
		env: process.env,
		cwd: REPO_ROOT,
	})
	await terminal.waitForText("ready")
	await terminal.stop()
	assert.equal(terminal.exit.signal, 9)
})
