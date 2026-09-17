#!/usr/bin/env node
/**
 * Dirac EXT — fork identity rename (WP0).
 *
 * Rewrites the extension's *identity* and its VS Code contribution ids from `dirac` to `dirac-ext`
 * so the fork installs side-by-side with upstream `dirac-run.dirac`.
 *
 * Deliberately NOT renamed (see dirac-ext/EXT_CHANGES.md):
 *   - `when`-clause context keys (`dirac.isFileUnderReview`, `dirac.isGeneratingCommit`, …) — private
 *     to the extension that sets them, and renaming them would touch 5 more upstream files.
 *   - the setting id `dirac.planActToggleShortcut` — shared with upstream on purpose.
 *   - the comment-controller id `dirac-ai-review`, all gRPC service names (`dirac.StateService`),
 *     telemetry metric names and the `~/.dirac/data` storage path (shared with upstream on purpose).
 *
 * Idempotent: running it twice is a no-op. Edits are text-level so package.json keeps upstream
 * formatting and the rebase diff stays minimal.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const OLD = "dirac"
const NEW = "dirac-ext"

let changed = 0
const log = (msg) => console.log(`[rename-extension] ${msg}`)

function edit(relPath, replacements) {
	const path = join(repoRoot, relPath)
	const before = readFileSync(path, "utf8")
	let text = before
	for (const [from, to] of replacements) {
		if (typeof from === "string") {
			if (!text.includes(from) && !text.includes(to)) {
				throw new Error(`${relPath}: neither ${JSON.stringify(from)} nor its renamed form was found`)
			}
			text = text.split(from).join(to)
		} else {
			text = text.replace(from, to)
		}
	}
	if (text !== before) {
		writeFileSync(path, text)
		changed++
		log(`updated ${relPath}`)
	} else {
		log(`unchanged (already renamed) ${relPath}`)
	}
}

// ---------------------------------------------------------------- package.json
const pkgPath = join(repoRoot, "package.json")
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
const commandIds = pkg.contributes.commands.map((c) => c.command).filter((id) => id.startsWith(`${OLD}.`))

const pkgReplacements = [
	[`"name": "${OLD}",`, `"name": "${NEW}",`],
	['"displayName": "Dirac",', '"displayName": "Dirac EXT",'],
	['"publisher": "dirac-run",', '"publisher": "lozza",'],
	[
		'"description": "Reduces API costs',
		'"description": "Dirac EXT — a fork of Dirac adding editor-tab instances, several simultaneous conversations, an Agent Map and a TokenSlayer tool. Reduces API costs',
	],
	// activity-bar container id + its view list key, and the sidebar webview id
	[`"${OLD}-ActivityBar"`, `"${NEW}-ActivityBar"`],
	[`"${OLD}.SidebarProvider"`, `"${NEW}.SidebarProvider"`],
	[`view == ${OLD}.SidebarProvider`, `view == ${NEW}.SidebarProvider`],
	// command ids (covers contributes.commands, menus, keybindings, commandPalette)
	...commandIds.map((id) => [`"${id}"`, `"${NEW}.${id.slice(OLD.length + 1)}"`]),
]
edit("package.json", pkgReplacements)

// Titles the user sees, and the EXT activity-bar icon. Done as narrow regexes so the
// upstream `walkthroughs` copy and the marketplace icon are left alone.
edit("package.json", [
	[/"viewsContainers": \{\s*\n(\s*)"activitybar": \[\s*\n\s*\{\s*\n\s*"id": "dirac-ext-ActivityBar",\s*\n\s*"title": "Dirac"/, (m) => m.replace('"title": "Dirac"', '"title": "Dirac EXT"')],
	[/"icon": "assets\/icons\/icon\.svg"/g, '"icon": "assets/icons/icon-ext.svg"'],
	[/("configuration": \{\s*\n\s*"title": )"Dirac"/, '$1"Dirac EXT"'],
	// command-palette category, so EXT's commands are distinguishable from upstream's
	[/"category": "Dirac"/g, '"category": "Dirac EXT"'],
])

// ------------------------------------------------------- hardcoded command ids in src
// These six are registered with string literals instead of ExtensionRegistryInfo.commands.
edit("src/extension.ts", [
	[`registerCommand("${OLD}.acceptEdit"`, `registerCommand("${NEW}.acceptEdit"`],
	[`registerCommand("${OLD}.saveWithMyChanges"`, `registerCommand("${NEW}.saveWithMyChanges"`],
	[`registerCommand("${OLD}.rejectEdit"`, `registerCommand("${NEW}.rejectEdit"`],
])
edit("src/hosts/vscode/review/VscodeCommentReviewController.ts", [
	[`registerCommand("${OLD}.reviewComment.reply"`, `registerCommand("${NEW}.reviewComment.reply"`],
	[`registerCommand("${OLD}.reviewComment.addToChat"`, `registerCommand("${NEW}.reviewComment.addToChat"`],
])
edit("src/dev/commands/tasks.ts", [[`registerCommand("${OLD}.dev.createTestTasks"`, `registerCommand("${NEW}.dev.createTestTasks"`]])

// `openWalkthrough` from the webview hardcodes the upstream publisher.
edit("src/core/controller/ui/openWalkthrough.ts", [
	["`dirac-run.${ExtensionRegistryInfo.name}#DiracWalkthrough`", "`${ExtensionRegistryInfo.id}#DiracWalkthrough`"],
])

// ---------------------------------------------------------------------- verify
const out = JSON.parse(readFileSync(pkgPath, "utf8"))
const problems = []
if (out.name !== NEW) problems.push(`name is ${out.name}`)
if (out.publisher !== "lozza") problems.push(`publisher is ${out.publisher}`)
if (out.contributes.views[`${NEW}-ActivityBar`]?.[0]?.id !== `${NEW}.SidebarProvider`) problems.push("sidebar view id not renamed")
for (const c of out.contributes.commands) {
	if (!c.command.startsWith(`${NEW}.`)) problems.push(`command not renamed: ${c.command}`)
}
for (const [menu, items] of Object.entries(out.contributes.menus)) {
	for (const item of items) {
		if (item.command?.startsWith(`${OLD}.`) && !item.command.startsWith(`${NEW}.`)) {
			problems.push(`${menu}: ${item.command}`)
		}
	}
}
for (const kb of out.contributes.keybindings) {
	if (kb.command.startsWith(`${OLD}.`) && !kb.command.startsWith(`${NEW}.`)) problems.push(`keybinding: ${kb.command}`)
}
if (problems.length) {
	console.error(`[rename-extension] FAILED:\n  - ${problems.join("\n  - ")}`)
	process.exit(1)
}
log(`ok — ${changed} file(s) written; extension id is now ${out.publisher}.${out.name}`)
