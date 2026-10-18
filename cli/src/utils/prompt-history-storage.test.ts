import { expect, it, vi } from "vitest"
import { TaskHistoryController } from "@/core/controller/TaskHistoryController"
import { getSavedDiracMessages } from "@core/storage/disk"
import { DiracMessageType } from "@shared/ExtensionMessage"

vi.mock("@core/storage/disk", () => ({ getSavedDiracMessages: vi.fn() }))

it("reads recent same-workspace public conversations, excludes the live run, and retains legacy initial prompts", async () => {
	const history = [
		{ id: "old", ts: 1, task: "legacy initial", cwdOnTaskInitialization: "/workspace" },
		{ id: "recent", ts: 3, task: "initial", workspaceRootPath: "/workspace" },
		{ id: "goal", ts: 4, task: "objective", runKind: "goal", shadowGitConfigWorkTree: "/workspace" },
		{ id: "live", ts: 5, task: "live", cwdOnTaskInitialization: "/workspace" },
		{ id: "other", ts: 6, task: "private", cwdOnTaskInitialization: "/elsewhere" },
	]
	vi.mocked(getSavedDiracMessages).mockImplementation(async (id) =>
		id === "recent"
			? [
					{ id: "1", ts: 1, content: { type: DiracMessageType.MARKDOWN, role: "user", content: "initial" } },
					{ id: "2", ts: 3, content: { type: DiracMessageType.MARKDOWN, role: "user", content: "follow-up" } },
				]
			: [],
	)
	const controller = new TaskHistoryController({ getGlobalStateKey: () => history } as never)
	expect(await controller.getPromptHistory("/workspace", "live")).toEqual([
		{ text: "objective", ts: 4 },
		{ text: "initial", ts: 1 },
		{ text: "follow-up", ts: 3 },
		{ text: "legacy initial", ts: 1 },
	])
	expect(vi.mocked(getSavedDiracMessages).mock.calls.map(([id]) => id)).toEqual(["goal", "recent", "old"])
})

it("bounds disk reads to the 20 most recent conversations without mutating stored inventory", async () => {
	vi.mocked(getSavedDiracMessages).mockClear().mockResolvedValue([])
	const history = Array.from({ length: 25 }, (_, index) => ({
		id: String(index),
		ts: index,
		task: `prompt ${index}`,
		cwdOnTaskInitialization: "/workspace",
	}))
	const controller = new TaskHistoryController({ getGlobalStateKey: () => history } as never)
	const prompts = await controller.getPromptHistory("/workspace")
	expect(prompts).toHaveLength(20)
	expect(prompts[0].text).toBe("prompt 24")
	expect(getSavedDiracMessages).toHaveBeenCalledTimes(20)
	expect(history[0].id).toBe("0")
})
