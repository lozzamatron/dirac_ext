import { accessSync, appendFileSync, constants, statSync } from "node:fs"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import xterm from "@xterm/headless"
import pty from "node-pty"

const specialKeys = {
	Up: "A",
	Down: "B",
	Right: "C",
	Left: "D",
	Home: "H",
	End: "F",
}
const tildeKeys = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6 }

export function encodeKey(chord) {
	const parts = chord.split("+")
	const key = parts.pop()
	const modifiers = new Set(parts)
	if (parts.some((part) => !["Ctrl", "Alt", "Shift"].includes(part))) throw new Error(`Unknown key chord: ${chord}`)
	const modifier = 1 + Number(modifiers.has("Shift")) + 2 * Number(modifiers.has("Alt")) + 4 * Number(modifiers.has("Ctrl"))
	if (key in specialKeys) return modifier === 1 ? `\x1b[${specialKeys[key]}` : `\x1b[1;${modifier}${specialKeys[key]}`
	if (key in tildeKeys) return `\x1b[${tildeKeys[key]}${modifier === 1 ? "" : `;${modifier}`}~`
	if (key === "Tab" && modifier === 2) return "\x1b[Z"
	if (key === "Enter" && modifier === 2) return "\x1b[13;2u" // CSI-u Shift+Enter
	const plain = { Enter: "\r", Escape: "\x1b", Tab: "\t", Backspace: "\x7f" }
	if (key in plain && modifier === 1) return plain[key]
	if (key?.length !== 1) throw new Error(`Unsupported key chord: ${chord}`)
	let value = modifiers.has("Shift") ? key.toUpperCase() : key
	if (modifiers.has("Ctrl")) {
		const code = value.toUpperCase().charCodeAt(0)
		if (code < 64 || code > 95) throw new Error(`Unsupported Ctrl key: ${chord}`)
		value = String.fromCharCode(code & 31)
	}
	return modifiers.has("Alt") ? `\x1b${value}` : value
}

export function positiveInteger(value, name, maximum = 500) {
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new Error(`${name} must be an integer from 1 to ${maximum}`)
	}
	return value
}

function resolveExecutable(command, cwd, env) {
	const candidates = command.includes("/")
		? [path.resolve(cwd, command)]
		: (env.PATH ?? "").split(path.delimiter).map((directory) => path.resolve(cwd, directory, command))
	for (const candidate of candidates) {
		try {
			accessSync(candidate, constants.X_OK)
			if (statSync(candidate).isFile()) return candidate
		} catch (error) {
			if (error.code !== "ENOENT" && error.code !== "EACCES" && error.code !== "ENOTDIR") throw error
		}
	}
	throw new Error(`Executable not found or not executable: ${command}`)
}

/** A real PTY plus a VT terminal emulator; no shell, Ink mocks, or stripped-ANSI guesses. */
export class TerminalSession {
	constructor({ command, args, cwd, env, cols = 100, rows = 30, outputPath }) {
		positiveInteger(cols, "cols")
		positiveInteger(rows, "rows")
		const executable = resolveExecutable(command, cwd, env)
		this.terminal = new xterm.Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true })
		this.lastOutputAt = Date.now()
		this.pendingWrites = 0
		this.exit = null
		this.pty = pty.spawn(executable, args, { cwd, env, cols, rows, name: "xterm-256color" })
		// Reply to device/cursor queries, just as a real terminal would.
		this.terminal.onData((data) => {
			if (!this.exit) this.pty.write(data)
		})
		this.pty.onData((data) => {
			if (outputPath) appendFileSync(outputPath, data)
			this.lastOutputAt = Date.now()
			this.pendingWrites++
			this.terminal.write(data, () => this.pendingWrites--)
		})
		this.exited = new Promise((resolve) => {
			this.pty.onExit((event) => {
				this.exit = event
				resolve(event)
			})
		})
	}

	write(text) {
		if (this.exit) throw new Error(`Terminal process exited: ${JSON.stringify(this.exit)}`)
		if (typeof text !== "string") throw new Error("text must be a string")
		this.pty.write(text)
	}

	paste(text) {
		if (typeof text !== "string") throw new Error("text must be a string")
		this.write(this.terminal.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text)
	}

	async press(key, count = 1) {
		positiveInteger(count, "count", 200)
		const encoded = encodeKey(key)
		for (let index = 0; index < count; index++) {
			this.write(encoded)
			// Do not coalesce multiple escape sequences into one Ink input event.
			await this.settle()
		}
	}

	resize(cols, rows) {
		positiveInteger(cols, "cols")
		positiveInteger(rows, "rows")
		if (this.exit) throw new Error("Cannot resize an exited process")
		this.terminal.resize(cols, rows)
		this.pty.resize(cols, rows)
	}

	async settle(timeoutMs = 3000) {
		const deadline = Date.now() + timeoutMs
		await delay(80)
		while (this.pendingWrites > 0 || Date.now() - this.lastOutputAt < 80) {
			if (Date.now() >= deadline) return // Streaming applications need not become idle.
			await delay(20)
		}
	}

	snapshot({ scrollback = false } = {}) {
		const buffer = this.terminal.buffer.active
		const lines = []
		const styledRuns = []
		for (let y = 0; y < this.terminal.rows; y++) {
			const line = buffer.getLine(buffer.viewportY + y)
			lines.push(line?.translateToString(true) ?? "")
			let run
			for (let x = 0; x < this.terminal.cols; x++) {
				const cell = line?.getCell(x)
				if (!cell || (cell.isBgDefault() && !cell.isInverse())) {
					run = undefined
					continue
				}
				const bg = { mode: cell.getBgColorMode(), value: cell.getBgColor() }
				const fg = { mode: cell.getFgColorMode(), value: cell.getFgColor() }
				const inverse = Boolean(cell.isInverse())
				if (
					run &&
					run.bg.mode === bg.mode &&
					run.bg.value === bg.value &&
					run.fg.mode === fg.mode &&
					run.fg.value === fg.value &&
					run.inverse === inverse
				) {
					run.text += cell.getChars()
					run.width++
					continue
				}
				run = { x, y, text: cell.getChars(), width: 1, bg, fg, inverse }
				styledRuns.push(run)
			}
		}
		const result = {
			cols: this.terminal.cols,
			rows: this.terminal.rows,
			screen: lines.join("\n"),
			lines,
			cursor: { x: buffer.cursorX, y: buffer.cursorY, baseY: buffer.baseY },
			styledRuns,
			exit: this.exit,
		}
		if (scrollback) {
			result.scrollback = Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index).translateToString(true))
		}
		return result
	}

	async waitForText(text, timeoutMs = 10000) {
		if (typeof text !== "string" || text.length === 0) throw new Error("wait text must be a nonempty string")
		positiveInteger(timeoutMs, "timeoutMs", 120000)
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			const snapshot = this.snapshot()
			if (snapshot.screen.includes(text)) {
				await this.settle()
				if (this.snapshot().screen.includes(text)) return this.snapshot()
			}
			if (this.exit) throw new Error(`Process exited before displaying ${JSON.stringify(text)}\n${snapshot.screen}`)
			await delay(30)
		}
		throw new Error(`Timed out waiting for ${JSON.stringify(text)}\n${this.snapshot().screen}`)
	}

	async stop() {
		if (!this.exit) {
			this.pty.kill("SIGTERM")
			const terminated = await Promise.race([this.exited.then(() => true), delay(1000).then(() => false)])
			if (!terminated) {
				this.pty.kill("SIGKILL")
				await this.exited
			}
		}
		await this.settle()
		this.terminal.dispose()
	}
}
