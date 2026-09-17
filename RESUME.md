# Dirac EXT — resume here

**State on 2026-09-17, ~00:15 local.** Fork at `dirac_ext/dirac-ext/`, Gitea `lozza/dirac-ext`,
upstream pinned at `041fce18` (v0.5.13).

| Branch | State |
|---|---|
| `ext/main` | WP0 + WP1 + WP1b + WP2 + **WP3** merged, pushed, **verified in the browser** |
| `ext/wp2-editor-tabs` | merged into `ext/main`; keep for history |
| `ext/wp3-tab-polish` | merged into `ext/main`; keep for history |
| `ext/wp4-agent-map` | merged into `ext/main`; keep for history |
| `ext/wp5-agent-map-backend` | merged into `ext/main`; keep for history |

**Next work packages, in HIS hands:** WP5b (the optional fleet map — decide whether it is wanted) and
WP6/WP7 (TokenSlayer). **WP6 was deliberately left untouched**: it changes his own Claude Code and Kilo
configuration, and `IMPLEMENTATION_PLAN.md` §7 still has an open question about TokenSlayer's role.

## Shipped and verified
- **WP0** — fork identity `lozza.dirac-ext` ("Dirac EXT"), side-by-side with upstream Dirac, sharing
  `~/.dirac/data`; EACCES fixed in source (`src/utils/fs.ts`). One task ran end to end.
- **WP1** — singleton → `InstanceRegistry`; nine event streams routed by controller id; the webview
  gets `instanceId` + `surface` through `window.__DIRAC_CONFIG__`.
- **WP1b** — routed streams became `Map<controllerId, Set<handler>>` (one webview subscribes twice;
  a single-handler map silently dropped the earlier subscriber), and the webview now consumes
  `subscribeToAddToInput`, so "Add to Dirac" finally reaches the chat input.

## WP2 — DONE (merged 2026-09-17)
Editor tabs, detach/re-attach, one owner per task. Acceptance **38 assertions, 0 failures**
(`dirac-ext/verification/wp2/`), fork tests 15 passing, full suite failing-NAMES identical to baseline.
Reviewed by GLM-5.3-Flash against deepseek's code: 8 findings, all fixed. Full detail in
`dirac-ext/EXT_CHANGES.md` § WP2.

Known rough edge handed to WP3: the re-attach quick pick labels a task with its raw id.

### What WP2 taught about verifying this thing
- **Playwright's `fill()` succeeds on a webview stacked BEHIND another one** — actionability checks do
  not cross the iframe boundary. Identify the front surface from the parent document:
  `frame.parentFrame().frameElement()` → `getComputedStyle(el).visibility === "visible"`.
- **Close the ACTIVE tab, never `.last()`** — several Dirac EXT tabs are open by then, and closing a
  finished conversation correctly disposes it, which looks exactly like "detach did not work".
- **The command palette leaves its list in the DOM.** Read a command's own quick pick via the visible
  widget and check its placeholder, or a stale palette row reads as a pass.
- **An assertion that cannot fail reports as a pass** — `innerText().replace(...).catch?.(...)` yields
  `""` on a string, so a whole cross-check compared everything against the empty string.
- **A "long-running" task must actually run long.** A 300-number reply finishes in ~5s and a correctly
  reaped background task is then indistinguishable from one that never detached. Ask for 4000.
- The extension logs its own tab-close decision and background-count inputs (`Dirac` output channel);
  when a browser result is ambiguous, read those before theorising.

## WP3 — DONE (merged 2026-09-17)
Tab titles that follow the conversation, the tab-only surface strip (badge + new-tab button), the
`openInNewTab` RPC with a host-supplied opener, a re-attach list labelled by conversation, a README
"Surfaces" section, and a Goal verified running end to end inside a tab. Acceptance **36 assertions**
(`dirac-ext/verification/wp3/`), fork tests 27 passing. Full detail in `dirac-ext/EXT_CHANGES.md` § WP3.

### What WP3 taught
- 🔴 **`deepseek-v4.1-flash:cloud` now returns an EMPTY answer for anything large** — a ~2,000-token
  prompt with no attachments, and a short prompt with a 619-line diff attached, both came back with
  `finish_reason=unknown` and no content; short prompts still work. **Author with GLM-5.3-Flash on
  `:8001`** (it took the identical prompts and wrote good code) and review with Qwen on `:8003`
  — which needs `enable_thinking: false`, or it burns the whole `max_tokens` budget reasoning and
  returns nothing.
- **A state pipeline cannot name a NEW conversation.** `currentTaskItem` is resolved out of the
  persisted task history, which has no entry until the first result is written, so a title taken only
  from state publications arrives a turn late — and *absence of a title in state is not evidence of
  absence of a task*, so the naive fallback resets a good title to the placeholder on every
  publication of the first turn. Two entry points, one guard. The browser found this; nothing else did.
- 🔴 **A re-created webview leaves its predecessor in `page.frames()` with its DOM frozen.** A
  first-match lookup then reads a transcript that never changes — indistinguishable from work that
  never finishes. Twice this reported a Goal as stuck while the screenshot taken seconds later showed
  it achieved. **Filter by the OUTER-iframe visibility already used to find the front surface**, and
  assert on a stable attribute (`aria-label^="Goal status:"`) rather than a word in a text blob.

## WP4 — DONE (merged 2026-09-17)
Agent Map v1: a modal overlay with the conversation as a root node, one child node per subagent run
and per Goal child task, elbow connectors, a detail drawer, a button in the chat strip and
`Ctrl/Cmd+Shift+M`. **Webview-only** — no extension-host code at all. Acceptance **33 assertions**
(`dirac-ext/verification/wp4/`), builder unit tests 19 passing against fixtures captured from real
runs. Full detail in `dirac-ext/EXT_CHANGES.md` § WP4.

### What WP4 taught
- 🔴 **`ui_messages.jsonl` is an operation LOG, not a message array.** Every subagent's final status,
  usage and trajectory arrives as a later `patch_card`, so a reader of the `create` records alone sees
  three agents stuck at "running" with no usage. Replay it through the REAL chat store
  (`applyPresentationBatch`) — and seed BOTH of its gates first (`presentationSurfaceId` must match the
  batch, and offsets must continue from `presentationOffset + 1`) or the replay silently yields nothing.
- **A guard that fails loudly is worth writing before the assertions it protects.** The replay helper
  asserts a non-empty message list up front; that is what turned "every assertion vacuously passes"
  into one clear failure naming the store's own rejection reason.
- 🔴 **CSS grid auto-placement is not deterministic enough to trust here.** A root spanning every child
  row put the third card inside the 40px connector column, one word per line. Place every cell
  explicitly, by column AND row.
- **Assert the property, not the model's wording.** Subagent task titles are generated, so
  `"Reply ALPHA"` became `"Reply with ALPHA"` on the next run and three assertions went red on correct
  code. Assert that each node names its own job and is not the `"Agent: job"` card header.
- **Two more browser traps:** headings uppercased by CSS come back from `innerText` UPPERCASE, and
  VS Code's hit test can resolve a click inside a webview to the iframe itself after the workbench
  re-lays-out (a theme change, a tab switch) — fall back to a DOM click, and say so in the log.

## WP5 — DONE (merged 2026-09-17)
Agent Map v1.5, the backend: a versioned `runs.json` sidecar written beside the subagent Markdown, an
`AgentMapService.getAgentMap(taskId)` RPC that assembles a snapshot from a task's records (including,
for each Goal child, that child's OWN runs), and a webview merge that adds what the transcript
structurally cannot contain. Acceptance **21 assertions** (`dirac-ext/verification/wp5/`), fork unit
tests 36 passing, webview agent-map tests 32 passing. Full detail in `dirac-ext/EXT_CHANGES.md` § WP5.

### What WP5 taught
- **Two sources of the same truth need a merge RULE, not a merge by id.** The live map keys a subagent
  node by the CARD that renders it, the disk map by the recorded RUN id, so an id-based merge draws
  every finished run twice. Decide what each source is authoritative for and take only that.
- **Depth has to be visible, not just present.** The grandchildren reached the map and were drawn in
  the same flat column as the Goal's own children — the map asserting a structure that never ran.
- **Concurrent writers to one file need the queue around the READ too.** Several subagents share one
  `runs.json`; serializing only the write still loses a run.
- **A partial record must merge, not replace.** A run is written twice — identity and prompt at the
  start, status and usage at the end — so a replace empties the drawer of everything the first write
  carried. And an update for a run that was never started is DROPPED: inventing an agent identity to
  satisfy the type would put a fabricated run on the map, drawn as real.
- 🔴 **`innerText` on a node card starts with the screen-reader-only status line** added in WP4, so
  `innerText.split("\n")[0]` reports every node as having the same name. Read the card's `title`
  attribute instead.

## Overnight run started 2026-09-17 ~01:50 (owner asleep; work autonomously, do not block on him)

Order: **WP3 ✅ → WP4 ✅ → WP5 ✅**. Merge each to `ext/main` and push before starting the next, so
an interruption never leaves the tree half-done. Do not touch WP6 (it changes HIS Claude Code / Kilo config
and §7 still has an open question about TokenSlayer's role) — leave it for him.

### WP3 scope (from IMPLEMENTATION_PLAN.md §3), with the design decisions already taken
1. **Tab title follows the task.** Seam: `sendStateUpdate(controllerId, state)` in
   `src/core/controller/state/subscribeToState.ts` already runs on every publication and
   `ExtensionState.currentTaskItem?: HistoryItem` carries the task text. After routing, notify
   `webviewInstances.byControllerId(controllerId)`; the VS Code provider sets the panel title when
   `surface === "tab"`. Same helper labels the re-attach quick pick (today it shows a raw task id).
2. **"New tab" button in the chat header, tab surface only.** Needs a new `openInNewTab` RPC on
   `UiService` (`proto/dirac/ui.proto` + a handler in `src/core/controller/ui/`), because the webview has
   no generic "run a host command" path. The handler must stay host-agnostic: use a
   `setTabOpener(fn)` / `openNewTab()` module the way WP2's `openTasks.setConflictHandler` works, with
   `extension.ts` supplying the VS Code implementation. **`npm run protos` after editing the proto.**
3. **Instance badge in the chat header** from `getSurface()` in `webview-ui/src/config/platform.config.ts`.
4. **README "Surfaces" section**, including that a tab can be dragged to the secondary side bar.
5. **A Goal started in a tab runs end to end** — verification only; no code unless it breaks.

Acceptance script to write: `tools/wp3-acceptance.mjs`, same shape as wp2's (see its header comments for
the three traps). Assertions: the tab's title text equals the start of the conversation after a task
starts; the badge reads "Tab" in a tab and is absent/"Sidebar" in the sidebar; the header button opens a
second tab with a NEW controller id; a Goal run in a tab reaches a terminal state.

### WP4 note — done
The fixtures are captured and committed (`tools/wp4-capture-fixture.mjs` re-captures them). Note that
`deepseek-v4.1-flash:cloud` could NOT be used as the vision-capable author the plan assumed — see the
delegation section below. The reference screenshot was described in words instead, and the layout was
checked against `reference_images/Screenshot 2026-09-14 083135.png` in the browser.

## How the work is delegated (this is the method — keep using it)
- **Author:** `mcp__local-models__ask_ollama` with `model: "deepseek-v4.1-flash:cloud"`,
  `temperature 0.2`, `top_p 0.95`. **Reviewer:** `mcp__local-models__ask_glm` (:8001 GLM-5.3-Flash),
  `reasoning_effort: "high"` — a different model from the author, as the plan requires.
- 🔴 **`glm-5.3:cloud` cannot do this work**: with `file_paths` attached AND a long answer requested it
  returns an empty answer every time. Do not retry it for code; use deepseek.
- 🔴 **Ask for WHOLE FILES, never SEARCH/REPLACE blocks.** Edit-block requests came back empty 3 times
  out of 4; whole-file output has never failed. Watch `max_tokens` — 12,000 truncated the second of two
  files mid-output.
- Pass real sources with `file_paths` (the server reads them, they never enter my context) and take the
  answer with `write_path` into `dirac_ext/handoffs/`.
- Every prompt is self-contained: why the change exists, the exact design (never "design it"), the
  output contract, the style rules (TABS, strict TS, no `any`, `tsc`+`biome` gate), an explicit
  **out-of-scope list**, and "do not claim the build or tests pass".
- Apply with `node tools/apply-model-output.mjs handoffs/<file>.md [--dry-run]` — it takes
  `=== FILE: path ===` / `=== END FILE ===` blocks, is all-or-nothing, and rejects a SEARCH that does
  not match exactly once. **Check every requested file actually came back** (an unterminated block is
  silently skipped).
- Small, already-diagnosed edits (a few lines, one file) I do myself; anything multi-file or
  >10 edits goes to the delegate.

## The loop I run after every change
```bash
bash logs/run-lint-types.sh      # tsc (extension + webview) and biome
bash logs/run-build.sh           # npm run package + vsce package -> builds/
code-server --install-extension builds/dirac-ext-0.5.13.vsix --force
node tools/<wp>-acceptance.mjs   # Playwright against the live code-server
bash logs/run-tests-ext.sh       # the fork's own tests (the full suite truncates — see below)
```
- Browser harness: `tools/cs-drive.mjs`. Its three traps: the password comes from the code-server
  **process env** (config.yaml is stale); drive `http://localhost:8443` (the LAN IP is an insecure
  context and webviews misbehave); a fresh browser profile opens the folder **untrusted**, and
  Restricted Mode disables every extension. It also auto-closes Dirac's "What's new" modal.
- 🔴 **The upstream unit suite truncates**: it collects 4,337 tests, runs ~2,498, and reports
  "75 failing" because a `SubagentRunner` afterEach aborts every later suite. Gate = failing-test
  **names** identical to `logs/test-unit-baseline.failnames`, plus `run-tests-ext.sh` green.
- Extension enable/disable in code-server is **per browser profile**: upstream Dirac is disabled in the
  Playwright profile only. Lozza still has to disable it once in his own window (Extensions → Dirac →
  Disable → Reload), or ask me to uninstall it server-side.

## Open with the owner
- Disable upstream Dirac in his own browser (chosen: disable, not uninstall) — still his click.
- Later WPs' questions from `IMPLEMENTATION_PLAN.md` §7 (TokenSlayer's role, fleet map, Kilo MCP scope).
