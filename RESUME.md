# Dirac EXT — resume here

**State on 2026-09-16, ~22:05 local.** Fork at `dirac_ext/dirac-ext/`, Gitea `lozza/dirac-ext`,
upstream pinned at `041fce18` (v0.5.13).

| Branch | State |
|---|---|
| `ext/main` | WP0 + WP1 + WP1b merged, pushed, **verified in the browser** |
| `ext/wp2-editor-tabs` | WP2 **WIP, pushed, not merged** — builds and tabs work; the deeper acceptance is unrun |

## Shipped and verified
- **WP0** — fork identity `lozza.dirac-ext` ("Dirac EXT"), side-by-side with upstream Dirac, sharing
  `~/.dirac/data`; EACCES fixed in source (`src/utils/fs.ts`). One task ran end to end.
- **WP1** — singleton → `InstanceRegistry`; nine event streams routed by controller id; the webview
  gets `instanceId` + `surface` through `window.__DIRAC_CONFIG__`.
- **WP1b** — routed streams became `Map<controllerId, Set<handler>>` (one webview subscribes twice;
  a single-handler map silently dropped the earlier subscriber), and the webview now consumes
  `subscribeToAddToInput`, so "Add to Dirac" finally reaches the chat input.

## WP2 — what is left (do these in order)
1. `code-server --install-extension builds/dirac-ext-0.5.13.vsix --force` after
   `bash logs/run-build.sh` (the last build may already be installed — check the VSIX timestamp).
2. `node tools/wp2-acceptance.mjs` — sections 1-2 pass today. Still to prove:
   - **no cross-talk**: three conversations, each transcript free of the other two markers;
   - **Move Conversation to a Tab** on an idle task (the busy predicate was fixed; re-verify);
   - **same history item twice** → the owning view is revealed, no second copy (needs a step writing);
   - **detach/re-attach**: close a tab mid-turn → status bar counts it → re-attach continues it.
3. Fix or send back whatever fails, then the reviewer pass (`ask_glm` on the WP2 diff — the author was
   `deepseek-v4.1-flash:cloud`, so the reviewer must be `glm-5.3-flash` on :8001).
4. `bash logs/run-tests-full.sh …` (compare failing NAMES to `logs/test-unit-baseline.failnames`) and
   `bash logs/run-tests-ext.sh` (must stay green — 14 tests).
5. Update `dirac-ext/EXT_CHANGES.md` with the WP2 section, commit, merge to `ext/main`, push.

Then WP3 (tab titles, header badge, README "Surfaces", Goal-in-a-tab), WP4/WP5 (Agent Map),
WP6/WP7 (TokenSlayer). Spec for all of it: `IMPLEMENTATION_PLAN.md`; WP2 detail: `handoffs/WP2_SPEC.md`.

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
