# Dirac EXT — resume here

**State on 2026-09-17, ~00:15 local.** Fork at `dirac_ext/dirac-ext/`, Gitea `lozza/dirac-ext`,
upstream pinned at `041fce18` (v0.5.13).

| Branch | State |
|---|---|
| `ext/main` | WP0 + WP1 + WP1b + **WP2** merged, pushed, **verified in the browser** |
| `ext/wp2-editor-tabs` | merged into `ext/main`; keep for history |

**Next work package: WP3** (tab titles showing the conversation, an instance badge in the webview
header, a README "Surfaces" section, Goal-in-a-tab). Spec: `IMPLEMENTATION_PLAN.md` §3.

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
