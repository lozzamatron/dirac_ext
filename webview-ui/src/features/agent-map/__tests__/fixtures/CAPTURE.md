# Agent Map fixtures — captured from real runs

Captured by `dirac_ext/tools/wp4-capture-fixture.mjs` against the live code-server, not written by
hand: the Agent Map builder is a pure function of Dirac's own records, so the fixtures have to be
Dirac's own output or the tests only prove the builder agrees with my guess about the card shape.

Captured 2026-09-17T07:13:10.739Z.

- `subagents-<taskId>-ui_messages.jsonl` — one task that ran three subagents in a single
  `use_subagents` call. This is the DiracMessage stream the chat store renders.
- `goal-<taskId>-goal.json` — one Goal that delegated to child tasks; the shape `state.goal` is
  assembled from.
- `*-task_metadata.json` — model and usage metadata for the same runs, including one per Goal CHILD
  task (the ids match `children[].id` in `goal.json`).

The child tasks' own `ui_messages.jsonl` were dropped: WP4 v1 is webview-only and reads the ROOT
task's messages plus the Goal state. Depth-2 nesting is WP5's problem, and re-running this script
recaptures them.

`ui_messages.jsonl` is an operation LOG, not a message array: `{offset, type: "create" | "patch_card"
| "patch_message" | "patch_api_status", ...}`. Replay it through the real chat store
(`useChatStore.getState().applyPresentationBatch(...)`) rather than reading the `create` records
alone — the final card status, trajectory and usage all arrive as patches.

Re-capture with `node dirac_ext/tools/wp4-capture-fixture.mjs` if upstream changes the card shape.
