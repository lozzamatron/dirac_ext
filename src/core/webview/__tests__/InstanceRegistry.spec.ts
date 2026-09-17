import { strict as assert } from "node:assert"
import { beforeEach, describe, it } from "mocha"
import { expectLoggerErrors } from "@/test/loggerGuard"
import type { DiracWebviewProvider } from "../WebviewProvider"
import { WebviewInstanceRegistry } from "../InstanceRegistry"

type FakeInstance = DiracWebviewProvider & { visible: boolean; disposed: boolean }

function fakeInstance(id: string, surface: "sidebar" | "tab", visible = false): FakeInstance {
	const instance = {
		surface,
		visible,
		disposed: false,
		controller: { id },
		isVisible() {
			return instance.visible
		},
		async dispose() {
			instance.disposed = true
			registry.unregister(instance as unknown as DiracWebviewProvider)
		},
	}
	return instance as unknown as FakeInstance
}

let registry: WebviewInstanceRegistry

describe("WebviewInstanceRegistry", () => {
	beforeEach(() => {
		registry = new WebviewInstanceRegistry()
	})

	it("separates the sidebar from tab instances and keeps insertion order", () => {
		const sidebar = fakeInstance("c-sidebar", "sidebar")
		const tab1 = fakeInstance("c-tab-1", "tab")
		const tab2 = fakeInstance("c-tab-2", "tab")
		for (const i of [sidebar, tab1, tab2]) {
			registry.register(i)
		}

		assert.equal(registry.count(), 3)
		assert.equal(registry.sidebar(), sidebar)
		assert.deepEqual(registry.tabs(), [tab1, tab2])
		assert.equal(registry.byControllerId("c-tab-2"), tab2)
		assert.equal(registry.byControllerId("nobody"), undefined)
	})

	it("resolves last-active: an active+visible instance wins, then the visible one, then the sidebar", () => {
		const sidebar = fakeInstance("c-sidebar", "sidebar")
		const tab = fakeInstance("c-tab", "tab")
		registry.register(sidebar)
		registry.register(tab)

		// nothing marked, nothing visible -> the sidebar
		assert.equal(registry.lastActiveInstance(), sidebar)

		// the visible one wins over an unmarked sidebar
		tab.visible = true
		assert.equal(registry.lastActiveInstance(), tab)

		// an instance marked active AND visible wins
		sidebar.visible = true
		registry.markActive(sidebar)
		assert.equal(registry.lastActiveInstance(), sidebar)

		// a marked-but-hidden instance loses to a visible one
		sidebar.visible = false
		assert.equal(registry.lastActiveInstance(), tab)
	})

	it("forgets an instance that unregisters, including as last-active", () => {
		const sidebar = fakeInstance("c-sidebar", "sidebar")
		const tab = fakeInstance("c-tab", "tab")
		registry.register(sidebar)
		registry.register(tab)
		registry.markActive(tab)

		registry.unregister(tab)

		assert.equal(registry.count(), 1)
		assert.equal(registry.byControllerId("c-tab"), undefined)
		assert.equal(registry.lastActiveInstance(), sidebar)
	})

	it("ignores markActive for an instance that is not registered", () => {
		const sidebar = fakeInstance("c-sidebar", "sidebar")
		const stranger = fakeInstance("c-stranger", "tab", true)
		registry.register(sidebar)

		registry.markActive(stranger)

		assert.equal(registry.lastActiveInstance(), sidebar)
	})

	it("disposeAll disposes every instance even when one of them throws", async () => {
		expectLoggerErrors()
		const good1 = fakeInstance("c-1", "sidebar")
		const bad = fakeInstance("c-2", "tab")
		const good2 = fakeInstance("c-3", "tab")
		bad.dispose = async () => {
			throw new Error("dispose exploded")
		}
		for (const i of [good1, bad, good2]) {
			registry.register(i)
		}

		await registry.disposeAll()

		assert.equal(good1.disposed, true)
		assert.equal(good2.disposed, true, "a failing dispose must not strand the instances after it")
		assert.equal(registry.count(), 0)
		assert.equal(registry.lastActiveInstance(), undefined)
	})
})
