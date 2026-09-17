import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import * as path from "node:path"
import { after, afterEach, before, beforeEach, describe, it } from "mocha"
import {
	SUBAGENT_RUNS_VERSION,
	readSubagentRunIndex,
	upsertSubagentRun,
	type SubagentRunRecord,
} from "../SubagentRunIndex"

let dir: string

function runsPath(): string {
	return path.join(dir, "subagents", "runs.json")
}

function runningRecord(runId: string, agentId: number): SubagentRunRecord {
	return {
		runId,
		agentId,
		agentName: `agent-${agentId}`,
		status: "running",
		startedAt: 1000 + agentId,
		prompt: `prompt for ${runId}`,
		taskTitle: `task for ${runId}`,
	}
}

before(async () => {
	// Touch the tmpdir once so a broken environment fails loudly before any test runs.
	await fs.access(os.tmpdir())
})

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-ext-runs-"))
})

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true })
})

after(async () => {
	// Nothing to tear down globally; kept for symmetry with the lifecycle hooks.
})

describe("Dirac EXT subagent run index", () => {
	it("reads a missing sidecar as undefined without treating it as an error", async () => {
		// A task that ran no subagents has no runs.json — ENOENT is the ordinary case here,
		// so the module must resolve to undefined and must NOT log an error for it.
		const result = await readSubagentRunIndex(runsPath())
		assert.equal(result, undefined)
	})

	it("reads an unparseable sidecar as undefined instead of throwing", async () => {
		// A half-written sidecar must read as "no data", never crash whatever renders the map.
		await fs.mkdir(path.dirname(runsPath()), { recursive: true })
		await fs.writeFile(runsPath(), "{ not json", "utf8")

		const result = await readSubagentRunIndex(runsPath())
		assert.equal(result, undefined)
	})

	it("reads a well-formed JSON file of the wrong shape as undefined", async () => {
		await fs.mkdir(path.dirname(runsPath()), { recursive: true })
		await fs.writeFile(runsPath(), JSON.stringify({ hello: "world" }), "utf8")
		assert.equal(await readSubagentRunIndex(runsPath()), undefined)

		// version and runs are both required; runs that is not an array fails the shape check too.
		await fs.writeFile(runsPath(), JSON.stringify({ version: 1, runs: "nope" }), "utf8")
		assert.equal(await readSubagentRunIndex(runsPath()), undefined)
	})

	it("creates the sidecar and its parent directory on first upsert and round-trips it", async () => {
		// Neither the subagents directory nor runs.json exists yet; the upsert must make both.
		await upsertSubagentRun(runsPath(), "task-1", runningRecord("run-1", 1))

		const file = await readSubagentRunIndex(runsPath())
		assert.notEqual(file, undefined)
		assert.equal(file!.version, SUBAGENT_RUNS_VERSION)
		assert.equal(file!.taskId, "task-1")
		assert.equal(file!.runs.length, 1)
		assert.equal(file!.runs[0].runId, "run-1")
		assert.equal(file!.runs[0].agentName, "agent-1")
	})

	it("merges a terminal update onto the running record instead of replacing it", async () => {
		// The terminal update does not repeat prompt/taskTitle/agentName/startedAt; a replace
		// would erase them and empty the map's drawer, so the merge must keep them.
		await upsertSubagentRun(runsPath(), "task-1", runningRecord("run-1", 1))
		await upsertSubagentRun(runsPath(), "task-1", {
			runId: "run-1",
			status: "completed",
			endedAt: 2000,
			usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
		})

		const file = await readSubagentRunIndex(runsPath())
		assert.notEqual(file, undefined)
		assert.equal(file!.runs.length, 1)
		const run = file!.runs[0]
		assert.equal(run.status, "completed")
		assert.equal(run.endedAt, 2000)
		assert.notEqual(run.usage, undefined)
		assert.equal(run.prompt, "prompt for run-1")
		assert.equal(run.taskTitle, "task for run-1")
		assert.equal(run.agentName, "agent-1")
		assert.equal(run.startedAt, 1001)
	})

	it("appends a different runId and leaves the first run intact, in insertion order", async () => {
		await upsertSubagentRun(runsPath(), "task-1", runningRecord("run-1", 1))
		await upsertSubagentRun(runsPath(), "task-1", runningRecord("run-2", 2))

		const file = await readSubagentRunIndex(runsPath())
		assert.notEqual(file, undefined)
		assert.equal(file!.runs.length, 2)
		assert.deepEqual(
			file!.runs.map((r) => r.runId),
			["run-1", "run-2"],
		)
		assert.equal(file!.runs[0].status, "running", "the first run must be untouched by the second upsert")
	})

	it("keeps all five runs when five upserts fire concurrently", async () => {
		// Two interleaved read-modify-write cycles would each read the same snapshot and the
		// second write would erase the first run — exactly what the module's per-path tail
		// queue exists to prevent. Fire all five at once, not one after another.
		const ids = ["run-1", "run-2", "run-3", "run-4", "run-5"]
		await Promise.all(
			ids.map((runId, i) => upsertSubagentRun(runsPath(), "task-1", runningRecord(runId, i + 1))),
		)

		const file = await readSubagentRunIndex(runsPath())
		assert.notEqual(file, undefined)
		assert.deepEqual(
			file!.runs.map((r) => r.runId).sort(),
			ids,
		)
	})

	it("drops an orphan update that lacks the identity fields instead of fabricating a run", async () => {
		// A terminal update with no "running" entry to merge onto would need an invented agent
		// identity to satisfy the shape — a fabricated run the map would draw as real. It must
		// be dropped, leaving only the one real run.
		await upsertSubagentRun(runsPath(), "task-1", runningRecord("run-1", 1))
		await upsertSubagentRun(runsPath(), "task-1", { runId: "ghost", status: "completed" })

		const file = await readSubagentRunIndex(runsPath())
		assert.notEqual(file, undefined)
		assert.equal(file!.runs.length, 1)
		assert.equal(file!.runs[0].runId, "run-1")
	})

	it("writes pretty-printed JSON a human can read while debugging a task", async () => {
		// Nobody commits this file, but a person opens it when a run goes wrong; it must not
		// be one unreadable line.
		await upsertSubagentRun(runsPath(), "task-1", runningRecord("run-1", 1))

		const raw = await fs.readFile(runsPath(), "utf8")
		assert.ok(raw.includes("\n"), "the sidecar must be multi-line")
		assert.ok(raw.includes('\n  "version"'), "the sidecar must use two-space indentation")
	})
})
