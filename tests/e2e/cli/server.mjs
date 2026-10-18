import { once } from "node:events"
import { chmod, mkdir, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import path from "node:path"
import { REPO_ROOT } from "./client.mjs"
import { startFixtureProvider } from "./fixture-provider.mjs"
import { positiveInteger, TerminalSession } from "./terminal-session.mjs"

const [sessionPath, serializedOptions] = process.argv.slice(2)
const options = JSON.parse(serializedOptions)
const idleMs = positiveInteger(options.idleMs ?? 900000, "idleMs", 86400000)
const fixtureEnabled = !options.live && !options.command
const home = path.join(sessionPath, "home")
const workspace = options.cwd ?? path.join(sessionPath, "workspace")
await mkdir(workspace, { recursive: true })
await mkdir(home, { recursive: true })
let fixture
let terminal
let idleTimer
let stopping = false
const server = createServer()

async function stop() {
	if (stopping) return
	stopping = true
	clearTimeout(idleTimer)
	// Stop accepting connections without waiting for this request's socket to close.
	server.close()
	await terminal?.stop()
	await fixture?.stop()
}

function resetIdleTimer() {
	clearTimeout(idleTimer)
	idleTimer = setTimeout(() => stop().catch(fail), idleMs)
}

function fail(error) {
	console.error(error)
	process.exitCode = 1
}

try {
	if (fixtureEnabled) fixture = await startFixtureProvider(home, options.fixture, workspace, options.vimMode)
	const env = options.live
		? { ...process.env }
		: {
				PATH: process.env.PATH,
				HOME: home,
				XDG_CONFIG_HOME: path.join(home, ".config"),
				XDG_CACHE_HOME: path.join(home, ".cache"),
				LANG: "C.UTF-8",
				DIRAC_DIR: home,
			}
	Object.assign(env, { TERM: "xterm-256color", COLORTERM: "truecolor", DIRAC_NO_AUTO_UPDATE: "1" })
	const bundlePath = path.join(REPO_ROOT, "cli/dist/cli.mjs")
	const command = options.command ?? process.execPath
	const args = options.args ?? [bundlePath, "--no-index", ...(fixtureEnabled ? ["--config", home, "--act"] : [])]
	const bundle = options.command ? null : { path: bundlePath, modifiedAt: (await stat(bundlePath)).mtime.toISOString() }
	terminal = new TerminalSession({
		command,
		args,
		cwd: workspace,
		env,
		cols: options.cols,
		rows: options.rows,
		outputPath: path.join(sessionPath, "terminal.ansi"),
	})

	async function execute(request) {
		switch (request.operation) {
			case "screen":
				break
			case "write":
				terminal.write(request.text)
				break
			case "paste":
				terminal.paste(request.text)
				break
			case "key":
				await terminal.press(request.key, request.count)
				break
			case "resize":
				terminal.resize(request.cols, request.rows)
				break
			case "wait":
				await terminal.waitForText(request.text, request.timeoutMs)
				break
			case "stop":
				await stop()
				return { stopped: true, session: sessionPath }
			default:
				throw new Error(`Unknown operation: ${request.operation}`)
		}
		await terminal.settle()
		return { ...terminal.snapshot({ scrollback: request.scrollback }), fixtureRequests: fixture?.requests ?? null }
	}

	let queue = Promise.resolve()
	server.on("connection", (socket) => {
		let input = ""
		socket.setTimeout(10000, () => socket.destroy())
		socket.on("error", (error) => console.error("Control socket:", error.message))
		socket.on("data", (data) => {
			input += data
			if (!input.includes("\n")) return
			socket.removeAllListeners("data")
			socket.setTimeout(0)
			clearTimeout(idleTimer)
			queue = queue
				.then(async () => {
					let request
					try {
						request = JSON.parse(input)
						socket.end(JSON.stringify({ ok: true, result: await execute(request) }))
					} catch (error) {
						socket.end(JSON.stringify({ ok: false, error: error.message }))
					}
					if (request?.operation === "stop") return
					resetIdleTimer()
				})
				.catch(fail)
		})
	})
	server.listen(path.join(sessionPath, "control.sock"))
	await once(server, "listening")
	await chmod(path.join(sessionPath, "control.sock"), 0o600)
	const metadata = {
		session: sessionPath,
		pid: process.pid,
		terminalPid: terminal.pty.pid,
		command,
		args,
		cwd: workspace,
		fixture: fixtureEnabled ? (options.fixture ?? "long-response") : null,
		bundle,
		idleMs,
	}
	await writeFile(path.join(sessionPath, "session.json"), JSON.stringify(metadata, null, 2), { mode: 0o600 })
	resetIdleTimer()
	for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => stop().catch(fail))
	process.send(metadata)
} catch (error) {
	await terminal?.stop()
	await fixture?.stop()
	throw error
}
