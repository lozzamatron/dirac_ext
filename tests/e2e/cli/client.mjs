import { spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { chmod, mkdtemp, readFile } from "node:fs/promises"
import { createConnection } from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))

/** The detached owner keeps the terminal alive between separate agent tool calls. */
export async function startSession(options = {}) {
	if (process.platform === "win32") throw new Error("The session control socket currently requires Linux or macOS")
	const session = await mkdtemp(path.join(os.tmpdir(), "dirac-tui-"))
	await chmod(session, 0o700)
	const logPath = path.join(session, "harness.log")
	const logFd = openSync(logPath, "a", 0o600)
	const child = spawn(
		process.execPath,
		[fileURLToPath(new URL("./server.mjs", import.meta.url)), session, JSON.stringify(options)],
		{
			detached: true,
			stdio: ["ignore", logFd, logFd, "ipc"],
		},
	)
	closeSync(logFd)
	try {
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				child.kill("SIGTERM")
				reject(new Error(`Harness startup timed out; inspect ${logPath}`))
			}, 15000)
			child.once("error", (error) => {
				clearTimeout(timer)
				reject(error)
			})
			child.once("exit", (code) => {
				clearTimeout(timer)
				readFile(logPath, "utf8").then((log) => reject(new Error(`Harness startup failed (${code})\n${log}`)), reject)
			})
			child.once("message", (result) => {
				clearTimeout(timer)
				child.removeAllListeners("exit")
				child.removeAllListeners("error")
				child.disconnect()
				child.unref()
				resolve(result)
			})
		})
	} catch (error) {
		child.kill("SIGTERM")
		throw error
	}
}

export async function requestSession(session, request) {
	const socketPath = path.join(session, "control.sock")
	return await new Promise((resolve, reject) => {
		const socket = createConnection(socketPath)
		let response = ""
		socket.setTimeout(180000, () => socket.destroy(new Error("Harness request timed out")))
		socket.on("error", reject)
		socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`))
		socket.on("data", (data) => {
			response += data
		})
		socket.once("end", () => {
			try {
				const result = JSON.parse(response)
				if (!result.ok) throw new Error(result.error)
				resolve(result.result)
			} catch (error) {
				reject(error)
			}
		})
	})
}
