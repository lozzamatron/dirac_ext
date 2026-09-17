import { strict as assert } from "node:assert"
import { afterEach, beforeEach, describe, it } from "mocha"
import { expectLoggerErrors } from "@/test/loggerGuard"
import type { DiracWebviewProvider } from "../WebviewProvider"
import { webviewInstances } from "../InstanceRegistry"
import type { ExtensionState } from "@/shared/ExtensionMessage"
import { DEFAULT_WEBVIEW_TITLE, MAX_WEBVIEW_TITLE_LENGTH, applyStateTitle, formatTaskTitle } from "../taskTitle"
import { openNewTab, setTabOpener } from "../tabOpener"

type FakeInstance = DiracWebviewProvider & { visible: boolean; disposed: boolean; title: string | undefined }

function fakeInstance(id: string, surface: "sidebar" | "tab", visible = false): FakeInstance {
	const instance = {
		surface,
		visible,
		disposed: false,
		title: undefined as string | undefined,
		controller: { id },
		isVisible() {
			return instance.visible
		},
		setTitle(title: string) {
			instance.title = title
		},
		async dispose() {
			instance.disposed = true
			webviewInstances.unregister(instance as unknown as DiracWebviewProvider)
		},
	}
	return instance as unknown as FakeInstance
}

function taskState(task: string): Partial<ExtensionState> {
	return { currentTaskItem: { task } } as unknown as Partial<ExtensionState>
}

describe("Dirac EXT webview titles", () => {
	let registered: FakeInstance[]

	beforeEach(() => {
		registered = []
	})

	afterEach(() => {
		for (const instance of registered) {
			webviewInstances.unregister(instance)
		}
		registered = []
	})

	it("falls back to the default title for a missing or blank task", () => {
		assert.equal(formatTaskTitle(undefined), DEFAULT_WEBVIEW_TITLE)
		assert.equal(formatTaskTitle("   \n  "), DEFAULT_WEBVIEW_TITLE)
	})

	it("returns a short single-line task unchanged", () => {
		const task = "Fix the login bug"
		assert.equal(formatTaskTitle(task), task)
	})

	it("collapses a multi-line task to a single line", () => {
		const task = "Fix the\n  login bug\ttoday"
		const title = formatTaskTitle(task)
		assert.equal(title.includes("\n"), false)
		assert.equal(title, "Fix the login bug today")
	})

	it("truncates a long task without inventing text", () => {
		const task = "Refactor the webview registry so that every host shares one rule for titles and disposal"
		const collapsed = task.replace(/\s+/g, " ").trim()
		const title = formatTaskTitle(task)

		assert.ok(title.length <= MAX_WEBVIEW_TITLE_LENGTH)
		assert.equal(title.endsWith("…"), true)
		assert.equal(
			collapsed.startsWith(title.slice(0, -1).trimEnd()),
			true,
			"the text before the ellipsis must be a prefix of the collapsed task",
		)
	})

	it("truncates a long unbroken word that has no space in the second half", () => {
		const task = "supercalifragilisticexpialidocious".repeat(4)
		const title = formatTaskTitle(task)

		assert.ok(title.length <= MAX_WEBVIEW_TITLE_LENGTH)
		assert.equal(title.endsWith("…"), true)
	})

	it("does not touch the title when the state has no currentTaskItem key", () => {
		const instance = fakeInstance("c-1", "tab")
		webviewInstances.register(instance)
		registered.push(instance)

		applyStateTitle("c-1", {})

		assert.equal(instance.title, undefined)
	})

	it("applies the formatted task title to the owning instance", () => {
		const instance = fakeInstance("c-1", "tab")
		webviewInstances.register(instance)
		registered.push(instance)

		applyStateTitle("c-1", taskState("Fix the\nlogin bug"))

		assert.equal(instance.title, "Fix the login bug")
	})

	it("does nothing for a controller id with no registered instance", () => {
		const instance = fakeInstance("c-1", "tab")
		webviewInstances.register(instance)
		registered.push(instance)

		assert.doesNotThrow(() => applyStateTitle("c-nobody", taskState("Orphan publication")))
		assert.equal(instance.title, undefined)
	})
})

describe("Dirac EXT tab opener", () => {
	beforeEach(() => {
		setTabOpener(undefined)
	})

	afterEach(() => {
		setTabOpener(undefined)
	})

	it("resolves to false when no opener is registered", async () => {
		// A missing opener logs a WARNING, not an ERROR, so no guard is needed.
		assert.equal(await openNewTab(), false)
	})

	it("runs the registered opener exactly once and resolves to true", async () => {
		let calls = 0
		setTabOpener(() => {
			calls++
		})

		assert.equal(await openNewTab(), true)
		assert.equal(calls, 1)
	})

	it("resolves to false when the opener rejects, without throwing", async () => {
		expectLoggerErrors()
		setTabOpener(async () => {
			throw new Error("tab open exploded")
		})

		assert.equal(await openNewTab(), false)
	})

	it("resolves to false again after the opener is cleared", async () => {
		let calls = 0
		setTabOpener(() => {
			calls++
		})
		setTabOpener(undefined)

		assert.equal(await openNewTab(), false)
		assert.equal(calls, 0)
	})
})
