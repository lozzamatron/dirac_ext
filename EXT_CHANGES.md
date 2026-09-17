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

## WP1 — instance registry + per-controller event routing (merged 2026-09-16)

**What it does:** removes the `DiracWebviewProvider` singleton and routes the nine per-webview event
streams by controller id, so a second webview (WP2's editor tabs) can exist without the two of them
overwriting each other's state. No tab is created yet — the sidebar is still the only instance.

### New files
| File | Purpose |
|---|---|
| `src/core/webview/InstanceRegistry.ts` | Process-local registry of live providers: `register/unregister/markActive`, `all/sidebar/tabs/visible/lastActiveInstance/byControllerId/count/disposeAll`, plus `controllerIdForTask(taskId)` for events fired deep in task code where no controller is in scope. |

### Touched upstream files
| File | Change |
|---|---|
| `src/core/webview/WebviewProvider.ts` | Singleton → registry. Constructor takes an optional `surface` (`"sidebar"` default) and registers **after** the controller exists. New statics `getSidebarInstance/getTabInstances/getVisibleInstance/getLastActiveInstance/getAllInstances/getInstanceByControllerId/disposeAllInstances`; `getInstance()` kept as a `@deprecated` alias for the last-active instance. |
| `src/core/controller/index.ts` | `readonly id = ulid()`; `sendStateUpdate(this.id, …)`; `sendChatButtonClickedEvent(this.id)`; `cleanupLegacyCheckpoints()` fires once per process, not once per controller. |
| 9 × `subscribeTo*.ts` (`state`, `showWebview`, `chatButtonClicked`, `settingsButtonClicked`, `historyButtonClicked`, `worktreesButtonClicked`, `addToInput`, `relinquishControl`, `accountButtonClicked`) | `Set<handler>` → `Map<controllerId, handler>`; each `send…Event` takes `controllerId` first and no-ops when that controller has no live subscription; every cleanup closure only deletes its own handler. `openRouterModels`, `liteLlmModels` and `checkpoints` stay broadcasts. |
| `src/extension.ts` | New Task → sidebar; settings/history/worktrees + accept/save/reject edit → `getLastActiveInstance() ?? getSidebarInstance()`; terminal add-to-chat → the instance `showWebview()` revealed; FocusChatInput resolves visible-then-sidebar, still calls `webviewView.show()` (see review finding 1), marks it active and targets its controller id. |
| `src/hosts/vscode/VscodeWebviewProvider.ts` | Visibility handler calls `markActive()` and `sendShowWebviewEvent(this.controller.id, true)`; `getInjectedConfig()` adds `instanceId` and `surface`. |
| `webview-ui/src/config/platform.config.ts` | `DiracRuntimeConfig` gains `instanceId`/`surface`; new `getInstanceId()` / `getSurface()` accessors, `DiracSurface` type. |
| `src/hosts/vscode/commandUtils.ts` | `showWebview()` returns the last-active instance (throws with a clear message when there is none) instead of the singleton. |
| `src/services/uri/SharedUriHandler.ts` | Visibility gate → existence gate; auth callbacks → last-active, `/task` → sidebar. |
| `src/core/controller/ui/getWebviewHtml.ts` | Standalone host renders the **sidebar** instance; throws a clear error when there is none. |
| `src/services/test/TestServer.ts` | `getVisibleInstance() ?? getLastActiveInstance()`. |
| `src/hosts/vscode/review/VscodeCommentReplyHandler.ts` | No controller in scope → sends the review conversation to the last-active instance, warns instead of throwing when there is none. |
| `src/integrations/checkpoints/{CheckpointDiffPresenter,CheckpointRestoreHandler}.ts` | `sendRelinquishControlEvent(controllerIdForTask(this.config.taskId))`, skipped when nothing resolves. |
| `src/core/controller/{commands/addToDirac,state/resetState,task/showTaskWithId}.ts`, `src/exports/index.ts` | Pass the in-scope controller's id to the routed senders. |

### Findings worth keeping
- **`BannerService.initialize()` is already idempotent** upstream (`if (BannerService.instance) return`), so the audit's "add a guard" item needed no change. Only `cleanupLegacyCheckpoints()` was guarded.
- **`sendAddToInputEvent` has no consumer in the webview** — nothing in `webview-ui/src` subscribes to `subscribeToAddToInput` in upstream 0.5.13 either, so "Add to Dirac" has never actually filled the chat input on this version. The routing change is faithful (the event now goes to one controller instead of an empty broadcast), but the feature is dead upstream. WP1's acceptance therefore asserts the handler ran with the right selection (Dirac's own log line), not that text appeared. Worth a separate fix or an upstream issue.
- **`controllerIdForTask()` falls back to the last-active instance** when no instance's `controller.task` matches (e.g. Goal child tasks). With one instance that is always right; with tabs it could re-enable the wrong webview's UI, so the fallback logs a warning when more than one instance exists. Revisit in WP2, when task↔instance ownership becomes explicit.
- Reviewer (`glm-5.3-flash` on :8001, different model from the author) returned SHIP WITH FIXES; its report is in `verification/wp1/reviewer-report-glm53flash.md`. Fixed before merge: the FocusChatInput `show()` regression, `disposeAll()` aborting on a rejected `dispose()`, and the silent `controllerIdForTask` fallback. Accepted as-is: throw→warn behaviour changes in the no-instance window, and state-size telemetry no longer recorded when nothing is subscribed.

---

## WP1b — "Add to Dirac" reaches the chat input, and the routing defect it exposed (merged 2026-09-16)

**The defect WP1 introduced.** Keying each routed stream `Map<controllerId, handler>` assumed ONE
subscriber per webview. The React app breaks that: `ChatViewContent` and `ModularChatView` both call
`useChatState()`, so a single webview subscribes twice, and — because React runs a parent's effect
after its child's — the surviving handler belonged to the outer component whose state renders nothing.
Measured in the browser: the editor selection reached the controller (Dirac logged it) and the visible
chat input stayed empty.

**Fix:** every routed stream is now `Map<controllerId, Set<handler>>` — still routed per webview (no
cross-talk between instances), but many subscribers inside one webview, as upstream's broadcast `Set`
allowed. Applies to the nine files converted in WP1.

**Upstream defect fixed in the fork:** nothing in `webview-ui/src` subscribed to `subscribeToAddToInput`,
so "Add to Dirac" / "Add terminal output to chat" had never filled the input on 0.5.13.
`webview-ui/src/features/modular-ui/chat/hooks/useChatState.ts` now subscribes, appends the text to
whatever is already typed and puts the caret at the end. Verified in the browser: the mention plus the
selected text land in the input, and a second add appends.

**New tests** (`src/core/webview/__tests__/InstanceRegistry.spec.ts`,
`src/core/controller/state/__tests__/subscribeToState.routing.test.ts`): 8 tests covering the last-active
ladder, unregister/dispose semantics, `disposeAll` surviving a throwing `dispose()`, and — the regression
that reached the browser — two subscribers of the same controller both receiving an update while another
controller receives nothing.

### ⚠️ The upstream unit suite TRUNCATES — what "75 failing" really means
`npm run test:unit` **collects 4,337 tests but only runs ~2,498 of them.** A failing `afterEach` hook in
`SubagentRunner` (the repo's own logger guard firing on
`this.baseConfig.coordinator.createEmptySibling is not a function`) aborts every suite scheduled after it,
so the run stops there and reports `2420 passing / 3 pending / 75 failing`. Proof: the same command with
`--dry-run` reports **4337 passing**. This is upstream behaviour at `041fce18`, identical before and after
the fork's changes.

Consequences for this fork:
- The suite number is still a valid regression gate *by failing-test name* (the truncation point is
  deterministic), but it is **not** coverage: any test that sorts after `SubagentRunner` never runs,
  including the fork's own `InstanceRegistry` tests.
- Every work package therefore also runs `dirac_ext/logs/run-tests-ext.sh`, which greps the EXT tests
  explicitly (`--grep "WebviewInstanceRegistry|subscribeToState routing|OpenTaskRegistry|Dirac EXT"`).
  WP1b: **8 passing, exit 0**.
- Fixing the upstream `SubagentRunner` mock would un-truncate ~1,800 tests. That is an upstream bug and a
  separate piece of work; it is not part of the fork's scope.

---

## WP2 — editor-tab instances, detach/re-attach, one-owner-per-task (branch `ext/wp2-editor-tabs`)

Three new commands, all under the `Dirac EXT` category:
`Open in New Tab`, `Move Conversation to a Tab`, `Re-attach a Background Task`.

### New files
- `src/core/task/OpenTaskRegistry.ts` — process-local owner map, `taskId -> controllerId`.
  **Why it has to exist:** Dirac's SQLite `FolderLock` is keyed by a per-**process** instance address, so
  two controllers inside the SAME extension host both acquire it and would interleave writes to one task.
  `claim()` refuses a second owner, reports through a conflict handler and never throws; `release()` is a
  no-op for a non-owner, so a losing view can never free the winner's live task.

### Touched upstream files
- `src/hosts/vscode/VscodeWebviewProvider.ts` — now hosts `WebviewView | WebviewPanel`.
  `resolveWebviewView(view)` keeps the exact `vscode.WebviewViewProvider` signature (adding an options
  parameter broke the interface) and delegates to `resolveSurface(viewOrPanel, { preserveTask })`.
  Adds `getPanel/reveal/setTitle/detach/isDetached/reattach/setPanelCloseHandler` and a `disposed` guard.
- `src/core/controller/task/TaskController.ts` — claims the task id immediately before
  `tryAcquireTaskLockWithRetryFn`, releases it on every failure path and in `clearTask()`.
- `src/core/controller/index.ts` — `dispose()` calls `openTasks.releaseAllFor(this.id)` as a backstop.
- `src/extension.ts` — the three commands, `openDiracTab()`, the shared `isTaskMidTurn()` predicate, the
  background-task status bar item and the conflict handler.
- `package.json` — the three commands, the `dirac-ext.tab` webview type and its `when` clauses.

### Two policies worth remembering
- **Closing a tab must not kill work.** The close handler returns `detach` while the task is mid-turn
  (panel gone, Controller and Task alive, status bar counts it) and `dispose` once it has settled.
- **`isTaskMidTurn()`, not `status !== IDLE`.** A *finished* task sits at `COMPLETED` (or `CANCELLED`), so
  the naive check calls every finished conversation busy — which is why the first cut of
  `Move Conversation to a Tab` refused to move a conversation that had clearly ended.

### Review findings fixed before merge (author `deepseek-v4.1-flash:cloud`, reviewer GLM-5.3-Flash on :8001)
1. **[high] `detached` was never cleared on re-attach.** Re-attach goes through `resolveSurface`, not the
   `reattach()` method, so a re-attached tab reported `isDetached() === true` forever and the status bar
   counted a task the user was looking at. `resolveSurface` now clears the flag for every binding.
2. **[high] a leaked claim was unrecoverable.** If anything after the claim threw (the SQLite lock retry
   exhausting, settings failing to load), the task stayed claimed by a controller with no task and could
   never be opened again in that window. Now released on every failure path, re-throwing the original
   error. Guarded by a test that fails without the fix.
3. **[medium] the background count lied once a detached task finished.** Both the count and the quick pick
   now filter on `isDetached() && isTaskMidTurn(...)`; a settled detached instance is reaped (disposed,
   which releases its claim so the conversation can be reopened from history), and while anything is
   genuinely running the status bar re-checks every 5s so it corrects itself with no user action.
4. **[medium] `reveal()` inverted `preserveFocus` for the sidebar** — `WebviewView.show()` takes
   preserveFocus directly, and the code passed `!preserveFocus`, disagreeing with the panel branch.
5. **[medium] the conflict message was a dead end for a detached owner** — `reveal()` silently does
   nothing without a panel, so that case now names the re-attach command instead.
6. **[low] `Move Conversation to a Tab` had a claim-free window** across the slow panel setup; the tab is
   now created first, then the release and re-claim happen back to back.
7. **[low]** `dispose()` could dispose an already-disposed panel (now try/caught), and a missing controller
   id silently skipped the claim (now warns).

The reviewer's two blocking unknowns were checked in the source, not guessed: `reinitExistingTaskFromId`
does route through the claiming `initTask`, and `postMessageToWebview` uses the `webview` field rather
than `getWebview()`, so tab instances receive events and a detached instance's sends no-op.

### Verified in the browser (`dirac_ext/tools/wp2-acceptance.mjs`, evidence in `verification/wp2/`)
- Sidebar + two editor tabs are **three distinct controller ids**, each reporting its own `surface`, with
  the side bar still usable beside them.
- **No cross-talk:** three conversations run at once and each transcript contains its own marker and
  none of the other two.
- **Opening a conversation another view owns** shows "already open in another Dirac EXT view", leaves
  exactly one view holding it, and reveals the owner rather than duplicating it.

### ⚠️ A harness trap that produced two false results
Playwright's actionability checks do not cross an iframe boundary. VS Code stacks all editor webviews at
identical coordinates and hides the inactive ones via `visibility: hidden` on the **outer** iframe, so
`fill()` aimed at a webview *behind* another one **succeeds** — the first run sent two of three prompts
into the same conversation and then "failed" its own cross-talk assertions. The front surface must be
identified from the parent document:
`frame.parentFrame().frameElement()` → `getComputedStyle(el).visibility === "visible"`.
The same run also carried a silently vacuous assertion (`innerText().replace(...).catch?.(...)` evaluates
to `""` on a string, so a cross-check compared everything against the empty string) — a reminder that an
assertion which cannot fail reports as a pass.

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
