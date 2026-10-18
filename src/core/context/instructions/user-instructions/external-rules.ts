import {
	combineRuleToggles,
	getRuleFilesTotalContent,
	readDirectoryRecursive,
	synchronizeRuleToggles,
} from "@core/context/instructions/user-instructions/rule-helpers"
import { formatResponse } from "@core/formatResponse"
import { GlobalFileNames } from "@core/storage/disk"
import { StateManager } from "@core/storage/StateManager"
import { findFilesByName } from "@services/glob/list-files"
import { DiracRulesToggles } from "@shared/dirac-rules"
import { fileExistsAtPath, isDirectory } from "@utils/fs"
import fs from "fs/promises"
import path from "path"
import { Logger } from "@/shared/services/Logger"

/**
 * Refreshes the toggles for windsurf, cursor, and agents rules
 */
export async function refreshExternalRulesToggles(
	stateManager: StateManager,
	workingDirectory: string,
	configuration?: {
		localWindsurfRulesToggles: DiracRulesToggles
		localCursorRulesToggles: DiracRulesToggles
		localAgentsRulesToggles: DiracRulesToggles
	},
): Promise<{
	windsurfLocalToggles: DiracRulesToggles
	cursorLocalToggles: DiracRulesToggles
	agentsLocalToggles: DiracRulesToggles
}> {
	// local windsurf toggles
	const localWindsurfRulesToggles =
		configuration?.localWindsurfRulesToggles ?? stateManager.getWorkspaceStateKey("localWindsurfRulesToggles")
	const localWindsurfRulesFilePath = path.resolve(workingDirectory, GlobalFileNames.windsurfRules)
	const updatedLocalWindsurfToggles = await synchronizeRuleToggles(localWindsurfRulesFilePath, localWindsurfRulesToggles)
	if (!configuration) stateManager.setWorkspaceState("localWindsurfRulesToggles", updatedLocalWindsurfToggles)

	// local cursor toggles
	const localCursorRulesToggles =
		configuration?.localCursorRulesToggles ?? stateManager.getWorkspaceStateKey("localCursorRulesToggles")

	// cursor has two valid locations for rules files, so we need to check both and combine
	// synchronizeRuleToggles will drop whichever rules files are not in each given path, but combining the results will result in no data loss
	let localCursorRulesFilePath = path.resolve(workingDirectory, GlobalFileNames.cursorRulesDir)
	const updatedLocalCursorToggles1 = await synchronizeRuleToggles(localCursorRulesFilePath, localCursorRulesToggles, ".mdc")

	localCursorRulesFilePath = path.resolve(workingDirectory, GlobalFileNames.cursorRulesFile)
	const updatedLocalCursorToggles2 = await synchronizeRuleToggles(localCursorRulesFilePath, localCursorRulesToggles)

	const updatedLocalCursorToggles = combineRuleToggles(updatedLocalCursorToggles1, updatedLocalCursorToggles2)
	if (!configuration) stateManager.setWorkspaceState("localCursorRulesToggles", updatedLocalCursorToggles)

	// local agents toggles
	const localAgentsRulesToggles =
		configuration?.localAgentsRulesToggles ?? stateManager.getWorkspaceStateKey("localAgentsRulesToggles")
	const localAgentsRulesFilePath = path.resolve(workingDirectory, GlobalFileNames.agentsRulesFile)
	const updatedLocalAgentsToggles = await synchronizeRuleToggles(localAgentsRulesFilePath, localAgentsRulesToggles)
	if (!configuration) stateManager.setWorkspaceState("localAgentsRulesToggles", updatedLocalAgentsToggles)

	return {
		windsurfLocalToggles: updatedLocalWindsurfToggles,
		cursorLocalToggles: updatedLocalCursorToggles,
		agentsLocalToggles: updatedLocalAgentsToggles,
	}
}

/**
 * Gather formatted windsurf rules
 */
export const getLocalWindsurfRules = async (cwd: string, toggles: DiracRulesToggles) => {
	const windsurfRulesFilePath = path.resolve(cwd, GlobalFileNames.windsurfRules)

	let windsurfRulesFileInstructions: string | undefined

	if (await fileExistsAtPath(windsurfRulesFilePath)) {
		if (!(await isDirectory(windsurfRulesFilePath))) {
			try {
				if (windsurfRulesFilePath in toggles && toggles[windsurfRulesFilePath] !== false) {
					const ruleFileContent = (await fs.readFile(windsurfRulesFilePath, "utf8")).trim()
					if (ruleFileContent) {
						windsurfRulesFileInstructions = formatResponse.windsurfRulesLocalFileInstructions(cwd, ruleFileContent)
					}
				}
			} catch (error) {
				Logger.error(`Failed to read .windsurfrules file at ${windsurfRulesFilePath}:`, error)
			}
		}
	}

	return windsurfRulesFileInstructions
}

/**
 * Gather formatted cursor rules, which can come from two sources
 */
export const getLocalCursorRules = async (cwd: string, toggles: DiracRulesToggles) => {
	// we first check for the .cursorrules file
	const cursorRulesFilePath = path.resolve(cwd, GlobalFileNames.cursorRulesFile)
	let cursorRulesFileInstructions: string | undefined

	if (await fileExistsAtPath(cursorRulesFilePath)) {
		if (!(await isDirectory(cursorRulesFilePath))) {
			try {
				if (cursorRulesFilePath in toggles && toggles[cursorRulesFilePath] !== false) {
					const ruleFileContent = (await fs.readFile(cursorRulesFilePath, "utf8")).trim()
					if (ruleFileContent) {
						cursorRulesFileInstructions = formatResponse.cursorRulesLocalFileInstructions(cwd, ruleFileContent)
					}
				}
			} catch (error) {
				Logger.error(`Failed to read .cursorrules file at ${cursorRulesFilePath}:`, error)
			}
		}
	}

	// we then check for the .cursor/rules dir
	const cursorRulesDirPath = path.resolve(cwd, GlobalFileNames.cursorRulesDir)
	let cursorRulesDirInstructions: string | undefined

	if (await fileExistsAtPath(cursorRulesDirPath)) {
		if (await isDirectory(cursorRulesDirPath)) {
			try {
				const rulesFilePaths = await readDirectoryRecursive(cursorRulesDirPath, ".mdc")
				const rulesFilesTotalContent = await getRuleFilesTotalContent(rulesFilePaths, cwd, toggles)
				if (rulesFilesTotalContent) {
					cursorRulesDirInstructions = formatResponse.cursorRulesLocalDirectoryInstructions(cwd, rulesFilesTotalContent)
				}
			} catch (error) {
				Logger.error(`Failed to read .cursor/rules directory at ${cursorRulesDirPath}:`, error)
			}
		}
	}

	return [cursorRulesFileInstructions, cursorRulesDirInstructions]
}

/** Discover all nested rules only when the root AGENTS.md enables the feature. */
async function findAgentsMdFiles(cwd: string): Promise<string[]> {
	const topLevelAgentsPath = path.resolve(cwd, GlobalFileNames.agentsRulesFile)
	if (!(await fileExistsAtPath(topLevelAgentsPath))) return []
	const nestedFiles = await findFilesByName(cwd, GlobalFileNames.agentsRulesFile)
	return [...new Set([topLevelAgentsPath, ...nestedFiles])]
}

/** Gather enabled AGENTS.md rules without silently accepting an incomplete discovery. */
export const getLocalAgentsRules = async (cwd: string, toggles: DiracRulesToggles) => {
	const agentsRulesFilePath = path.resolve(cwd, GlobalFileNames.agentsRulesFile)
	if (toggles[agentsRulesFilePath] === false) return undefined
	const sections: string[] = []
	for (const filePath of await findAgentsMdFiles(cwd)) {
		if (toggles[filePath] === false) continue
		const content = (await fs.readFile(filePath, "utf8")).trim()
		if (content) sections.push(`## ${path.relative(cwd, filePath)}\n\n${content}`)
	}
	if (sections.length) return formatResponse.agentsRulesLocalFileInstructions(cwd, sections.join("\n\n"))
	return undefined
}
