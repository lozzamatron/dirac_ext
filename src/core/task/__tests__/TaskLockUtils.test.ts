import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, it } from "mocha"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { getTaskDirectoryPath } from "@core/storage/taskDirectory"
import { acquireTaskLock } from "../TaskLockUtils"

const runNode = promisify(execFile)

describe("exclusive task ownership", () => {
	let storageDirectory: string

	beforeEach(async () => {
		storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-task-lock-"))
		setVscodeHostProviderMock({ globalStorageFsPath: storageDirectory })
	})

	afterEach(async () => {
		HostProvider.reset()
		await fs.rm(storageDirectory, { recursive: true, force: true })
	})

	it("rejects a second open and permits reopening after release", async () => {
		const release = await acquireTaskLock(getTaskDirectoryPath("task"))
		try {
			await assert.rejects(
				acquireTaskLock(getTaskDirectoryPath("task")),
				/This task is already open in another Dirac instance\. Close it there before opening it here\./,
			)
		} finally {
			await release()
		}
		const releaseReopened = await acquireTaskLock(getTaskDirectoryPath("task"))
		await releaseReopened()
	})

	it("excludes a writer in a different process", async () => {
		const release = await acquireTaskLock(getTaskDirectoryPath("cross-process"))
		try {
			const { stdout } = await runNode(process.execPath, [
				"-e",
				`require('proper-lockfile').lock(process.argv[1], { realpath: false, retries: 0 })
					.then(async release => { await release(); console.log('acquired') })
					.catch(error => { console.log(error.code) })`,
				getTaskDirectoryPath("cross-process"),
			])
			assert.equal(stdout.trim(), "ELOCKED")
		} finally {
			await release()
		}
	})

	it("allows distinct task IDs to be open simultaneously", async () => {
		const releaseFirst = await acquireTaskLock(getTaskDirectoryPath("first"))
		try {
			const releaseSecond = await acquireTaskLock(getTaskDirectoryPath("second"))
			await releaseSecond()
		} finally {
			await releaseFirst()
		}
	})

	it("reclaims an expired lease left by a crashed instance", async () => {
		const lockDirectory = `${getTaskDirectoryPath("crashed")}.lock`
		await fs.mkdir(lockDirectory, { recursive: true })
		const expired = new Date(Date.now() - 60_000)
		await fs.utimes(lockDirectory, expired, expired)
		const release = await acquireTaskLock(getTaskDirectoryPath("crashed"))
		await release()
	})

	it("acquires before creating or changing task history", async () => {
		const release = await acquireTaskLock(getTaskDirectoryPath("unopened"))
		try {
			await assert.rejects(fs.stat(getTaskDirectoryPath("unopened")), { code: "ENOENT" })
		} finally {
			await release()
		}
	})
})
