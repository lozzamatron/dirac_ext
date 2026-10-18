import assert from "node:assert/strict"
import { describe, it } from "mocha"
import type { ApiConfiguration } from "@shared/api"
import type { Settings } from "@shared/storage/state-keys"
import {
	createTaskWorkingConfiguration,
	type TaskWorkingConfiguration,
	type TaskWorkingConfigurationInput,
} from "@core/task/runtime/TaskWorkingConfiguration"
import { GoalTaskFactory } from "../GoalTaskFactory"

function configuration(hooksEnabled: boolean, doubleCheckCompletionEnabled: boolean): TaskWorkingConfiguration {
	return createTaskWorkingConfiguration({
		settings: { hooksEnabled, doubleCheckCompletionEnabled } as Settings,
		apiConfiguration: {} as ApiConfiguration,
		workspaceConfiguration: {} as TaskWorkingConfigurationInput["workspaceConfiguration"],
		executionOptions: {
			terminalReuseEnabled: false,
			vscodeTerminalExecutionMode: "backgroundExec",
			multiRootEnabled: false,
		},
	})
}

describe("GoalTaskFactory working configuration", () => {
	it("disables nested completion checks only for verification children", () => {
		const source = configuration(true, true)
		const factory = new GoalTaskFactory({ workingConfiguration: source } as ConstructorParameters<typeof GoalTaskFactory>[0])
		const workingConfiguration = factory["workingConfiguration"].bind(factory)

		const verifier = workingConfiguration("goal_child", "verification")
		const worker = workingConfiguration("goal_child", "task")
		assert.equal(verifier.settings.doubleCheckCompletionEnabled, false)
		assert.equal(verifier.settings.hooksEnabled, false)
		assert.equal(worker.settings.doubleCheckCompletionEnabled, true)
		assert.equal(worker.settings.hooksEnabled, false)
		assert.strictEqual(workingConfiguration("goal_coordinator"), source)
		assert.strictEqual(workingConfiguration("goal_followup"), source)
		assert.equal(source.settings.doubleCheckCompletionEnabled, true)
	})

	it("isolates verification without requiring hooks to be enabled", () => {
		const source = configuration(false, true)
		const factory = new GoalTaskFactory({ workingConfiguration: source } as ConstructorParameters<typeof GoalTaskFactory>[0])
		const workingConfiguration = factory["workingConfiguration"].bind(factory)

		assert.equal(workingConfiguration("goal_child", "verification").settings.doubleCheckCompletionEnabled, false)
		assert.strictEqual(workingConfiguration("goal_child", "task"), source)
	})
})
