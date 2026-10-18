import { readFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { requestSession, startSession } from "./client.mjs"

const HELP = `Persistent CLI terminal harness (Linux/macOS)

  npm run cli:tui -- start [--fixture long-response|long-plan|markdown-plan|markdown-response|create-file|edit-file] [--live] [--cwd DIR] [--cols N] [--rows N]
  npm run cli:tui -- start -- node /absolute/path/to/program.mjs
  npm run cli:tui -- screen --session DIR [--scrollback]
  npm run cli:tui -- write --session DIR --text 'hello'
  npm run cli:tui -- paste --session DIR --file /path/to/draft.txt
  npm run cli:tui -- key --session DIR --key Up [--count 3]
  npm run cli:tui -- resize --session DIR --cols 80 --rows 24
  npm run cli:tui -- wait --session DIR --text 'Response line 80' [--timeout 30000]
  npm run cli:tui -- stop --session DIR

start defaults to the built local CLI, an isolated home/workspace, and a
loopback canned provider (no live model calls). --live inherits your environment
and credentials; specify --cwd to work in your repository. Always rebuild first.
Keys: Up/Down/Left/Right, Home/End, Enter, Tab, Escape, Backspace, Delete,
PageUp/PageDown, Ctrl+a, Ctrl+e, Ctrl+c, Alt+Left, Shift+Down, Shift+Enter (CSI-u), etc.
All output is JSON. See tests/e2e/cli/README.md for the JS API and cursor details.
`

async function main() {
	const [operation, ...args] = process.argv.slice(2)
	if (!operation || operation === "help" || operation === "--help") {
		process.stdout.write(HELP)
		return
	}
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		options: {
			session: { type: "string" },
			live: { type: "boolean", default: false },
			fixture: { type: "string" },
			cwd: { type: "string" },
			cols: { type: "string" },
			rows: { type: "string" },
			text: { type: "string" },
			file: { type: "string" },
			key: { type: "string" },
			count: { type: "string" },
			timeout: { type: "string" },
			idle: { type: "string" },
			scrollback: { type: "boolean", default: false },
		},
	})
	if (operation === "start") {
		const result = await startSession({
			live: values.live,
			fixture: values.fixture,
			cwd: values.cwd ? path.resolve(values.cwd) : undefined,
			cols: values.cols === undefined ? undefined : Number(values.cols),
			rows: values.rows === undefined ? undefined : Number(values.rows),
			idleMs: values.idle === undefined ? undefined : Number(values.idle),
			command: positionals[0],
			args: positionals.length ? positionals.slice(1) : undefined,
		})
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
		return
	}
	if (!values.session) throw new Error("--session is required; use the directory returned by start")
	if (positionals.length) throw new Error("Unexpected positional arguments")
	if (values.text !== undefined && values.file !== undefined) throw new Error("Use either --text or --file, not both")
	const text = values.file ? await readFile(values.file, "utf8") : values.text
	const result = await requestSession(path.resolve(values.session), {
		operation,
		text,
		key: values.key,
		count: values.count === undefined ? undefined : Number(values.count),
		cols: values.cols === undefined ? undefined : Number(values.cols),
		rows: values.rows === undefined ? undefined : Number(values.rows),
		timeoutMs: values.timeout === undefined ? undefined : Number(values.timeout),
		scrollback: values.scrollback,
	})
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

main().catch((error) => {
	process.stderr.write(`${error.message}\n`)
	process.exitCode = 1
})
