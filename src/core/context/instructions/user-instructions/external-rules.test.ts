import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { describe, it } from "mocha"
import { getLocalAgentsRules } from "./external-rules"

describe("AGENTS rule discovery", () => {
	it("preserves explicit root rules and nested toggles", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-agents-rules-"))
		try {
			await promisify(execFile)("git", ["init", "-q", root])
			await fs.mkdir(path.join(root, "nested"))
			await fs.writeFile(path.join(root, "AGENTS.md"), "ROOT_INSTRUCTIONS")
			await fs.writeFile(path.join(root, "nested", "AGENTS.md"), "NESTED_INSTRUCTIONS")
			await fs.writeFile(path.join(root, ".gitignore"), "/AGENTS.md\n")
			const instructions = await getLocalAgentsRules(root, { [path.join(root, "nested", "AGENTS.md")]: false })
			assert(instructions?.includes("ROOT_INSTRUCTIONS"))
			assert(!instructions?.includes("NESTED_INSTRUCTIONS"))
			assert.equal(await getLocalAgentsRules(root, { [path.join(root, "AGENTS.md")]: false }), undefined)
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})
})
