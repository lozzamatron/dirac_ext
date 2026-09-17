import { strict as assert } from "node:assert"
import { beforeEach, describe, it } from "mocha"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { OpenTaskRegistry } from "../OpenTaskRegistry"

/**
 * Dirac EXT: the SQLite task lock is keyed by a per-process instance address, so two controllers in
 * ONE window both "acquire" the same task. This registry is the process-local guard that stops the
 * same conversation running twice and writing over its own history.
 */
describe("OpenTaskRegistry", () => {
	let registry: OpenTaskRegistry

	beforeEach(() => {
		registry = new OpenTaskRegistry()
	})

	it("gives the task to the first claimant and refuses the second", () => {
		assert.equal(registry.claim("task-1", "controller-a"), true)
		assert.equal(registry.claim("task-1", "controller-b"), false)
		assert.equal(registry.ownerOf("task-1"), "controller-a")
		assert.equal(registry.isOwnedByOther("task-1", "controller-b"), true)
		assert.equal(registry.isOwnedByOther("task-1", "controller-a"), false)
	})

	it("is idempotent for the owner", () => {
		assert.equal(registry.claim("task-1", "controller-a"), true)
		assert.equal(registry.claim("task-1", "controller-a"), true)
		assert.equal(registry.count(), 1)
	})

	it("reports a conflict to the handler with all three ids", () => {
		const seen: Array<{ taskId: string; ownerControllerId: string; requestingControllerId: string }> = []
		registry.setConflictHandler((conflict) => seen.push(conflict))

		registry.claim("task-1", "controller-a")
		registry.claim("task-1", "controller-b")

		assert.deepEqual(seen, [{ taskId: "task-1", ownerControllerId: "controller-a", requestingControllerId: "controller-b" }])
	})

	it("refuses the claim even when the conflict handler throws", () => {
		expectLoggerErrors()
		registry.setConflictHandler(() => {
			throw new Error("reveal exploded")
		})
		registry.claim("task-1", "controller-a")

		assert.equal(registry.claim("task-1", "controller-b"), false, "a throwing handler must not grant the claim")
		assert.equal(registry.ownerOf("task-1"), "controller-a")
	})

	it("only the owner can release, and releasing frees the task for someone else", () => {
		registry.claim("task-1", "controller-a")

		registry.release("task-1", "controller-b")
		assert.equal(registry.ownerOf("task-1"), "controller-a", "a stale release must not free another controller's claim")

		registry.release("task-1", "controller-a")
		assert.equal(registry.ownerOf("task-1"), undefined)
		assert.equal(registry.claim("task-1", "controller-b"), true)
	})

	it("releaseAllFor drops every claim held by a disposed controller", () => {
		registry.claim("task-1", "controller-a")
		registry.claim("task-2", "controller-a")
		registry.claim("task-3", "controller-b")

		registry.releaseAllFor("controller-a")

		assert.equal(registry.ownerOf("task-1"), undefined)
		assert.equal(registry.ownerOf("task-2"), undefined)
		assert.equal(registry.ownerOf("task-3"), "controller-b")
		assert.equal(registry.count(), 1)
	})
})
