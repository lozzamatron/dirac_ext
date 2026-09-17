# Dirac EXT — change map (rebase ledger)

Every deviation from upstream `dirac-run/dirac`, so a rebase onto a new upstream tag is a known,
bounded job. **Rule:** new behaviour goes in new files; touches to upstream files stay mechanical.

- Fork point: upstream `main` @ `041fce18` (v0.5.13, 2026-09-16), branch `ext/main`.
- Remotes: `upstream` = https://github.com/dirac-run/dirac · `origin` = Gitea `lozza/dirac-ext` (private).
- Extension identity: `lozza.dirac-ext`, display name **Dirac EXT**. Installs side-by-side with
  `dirac-run.dirac` and shares `~/.dirac/data` on purpose.

## Deliberately NOT renamed (shared with upstream by design)

| Thing | Why |
|---|---|
| `when`-clause context keys (`dirac.isDevMode`, `dirac.isFileUnderReview`, `dirac.isFileModified`, `dirac.isGeneratingCommit`, `dirac.isTestMode`) | Private to the extension that sets them; renaming would touch 5 more upstream files for no behavioural gain. |
| Setting id `dirac.planActToggleShortcut` | Shared with upstream deliberately — one keybinding preference. |
| Comment-controller id `dirac-ai-review` | Per-extension namespace already. |
| gRPC service names (`dirac.StateService`, …), proto package, telemetry metric names (`dirac.*`) | Internal wire names; renaming breaks generated code and the recorder fixtures. |
| Storage root `~/.dirac/data` | Shared history with upstream is a feature. |
| `assets/icons/icon.png` (marketplace icon), walkthrough id `DiracWalkthrough` | Unchanged; walkthrough id is namespaced by extension id. |

---

## New files (EXT-only — rebase keeps these verbatim)

| File | WP | Purpose |
|---|---|---|
| `scripts/rename-extension.mjs` | WP0 | Idempotent fork-identity rename (package.json + 6 hardcoded command ids in `src/`). Re-run after any rebase that reintroduces upstream ids. |
| `assets/icons/icon-ext.svg` | WP0 | Activity-bar icon: upstream's delta with three agent dots instead of one (legible at 16px, unlike a text badge). |
| `EXT_CHANGES.md` | WP0 | This file. |

## Touched upstream files

| File | WP | Change | Rebase note |
|---|---|---|---|
| `package.json` | WP0 | `name` → `dirac-ext`, `displayName` → `Dirac EXT`, `publisher` → `lozza`, description prefixed; activity-bar container id `dirac-ActivityBar` → `dirac-ext-ActivityBar`; sidebar view id `dirac.SidebarProvider` → `dirac-ext.SidebarProvider` (+ the `view ==` clauses); all 21 command ids `dirac.*` → `dirac-ext.*`; command-palette `category` → `Dirac EXT`; configuration title → `Dirac EXT`; activity-bar icon → `icon-ext.svg`. | Re-run `node scripts/rename-extension.mjs`; it is idempotent and fails loudly if upstream renames a key. |
| `src/extension.ts` | WP0 | 3 hardcoded command ids (`dirac.acceptEdit`, `dirac.saveWithMyChanges`, `dirac.rejectEdit`) → `dirac-ext.*`. | Handled by the rename script. |
| `src/hosts/vscode/review/VscodeCommentReviewController.ts` | WP0 | 2 hardcoded command ids (`dirac.reviewComment.reply`, `.addToChat`) → `dirac-ext.*`. | Handled by the rename script. |
| `src/dev/commands/tasks.ts` | WP0 | `dirac.dev.createTestTasks` → `dirac-ext.dev.createTestTasks`. | Handled by the rename script. |
| `src/core/controller/ui/openWalkthrough.ts` | WP0 | Hardcoded `dirac-run.${name}` publisher → `ExtensionRegistryInfo.id`, so the webview's "Open walkthrough" opens **this** extension's walkthrough. | Handled by the rename script. |
| `src/utils/fs.ts` | WP0 | Added `isNotAccessible()` (EACCES/EPERM) and OR'd it into the three existing `isNotFound(error) \|\| isNotADirectory(error)` guards in `fileExistsAtPath`, `isDirectory`, `getFileSizeInKB`. **Why:** upstream only catches ENOENT, so a workspace walk that crosses a directory owned by another user throws and kills the task before any API call — the crash this host patches into upstream's minified bundle (`/config/custom-cont-init.d/03-patch-dirac-eaccess`). Building from source makes that init-script patch unnecessary for EXT (its glob only matches `dirac-run.dirac-*` anyway). | Keep; re-apply if upstream refactors `src/utils/fs.ts`. Upstream fix would make this redundant — check before re-applying. |
| `package-lock.json` | WP0 | Root package name follows `package.json`; plus `peer: true` normalisation written by npm 10.8 (node 22) on `npm install`. | Regenerate rather than merge: take upstream's file, re-run `npm install`. |

---

## Build-host facts (not fork changes — they bite every WP)

- **`npm run package` needs `unzip`, which this container does not have.** `scripts/prepare-extension-ripgrep-binaries.mjs`
  extracts the win-x64 ripgrep `.zip` with `execFileSync("unzip", …)`. A python shim lives at
  `dirac_ext/tools/bin/unzip`; every build wrapper in `dirac_ext/logs/run-*.sh` puts it on `PATH`.
- **`npm run test:unit` is NOT green on upstream.** Pristine upstream @ `041fce18` scores
  **2417 passing / 3 pending / 75 failing (exit 75)** — and Dirac EXT scores exactly the same, with an
  identical set of failing test names (`verification/wp0/test-unit-*.log`). The gate for every WP is
  therefore **"no delta against that baseline"**, not "exit 0". Re-measure the baseline after any rebase
  (`dirac_ext/logs/run-baseline.sh` builds a detached worktree at the pinned commit and runs it).
- **Browser verification harness:** `dirac_ext/tools/cs-drive.mjs` + `wp0-acceptance.mjs` (kept outside the
  repo so the fork diff stays clean). Three traps it encodes: code-server's password comes from the server
  process's environment (config.yaml is stale); drive `http://localhost:8443`, because over the LAN IP the
  browser is an insecure context and VS Code warns that webviews may not work; and a fresh browser profile
  opens the folder **untrusted**, where Restricted Mode disables every third-party extension — so the
  activity bar shows five built-ins and no `dirac-ext.*` command exists until the workspace is trusted.
