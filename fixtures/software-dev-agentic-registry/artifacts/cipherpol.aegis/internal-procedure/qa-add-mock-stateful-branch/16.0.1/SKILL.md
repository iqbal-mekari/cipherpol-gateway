---
name: qa-add-mock-stateful-branch
description: Add one stateful, sequenced, or dynamic-echo branch to the hermetic mock server's response pipeline (stage ④/⑤) — state store, write mutation, read splice, and reset registration. Called by qa-mock-worker.
user-invocable: false
---

Add exactly one stateful/sequenced/mutation branch from the Gate M-approved inventory, editing only pipeline stage ④/⑤ of `mock_server.dart`.

## Steps

1. Load `$CLAUDE_PLUGIN_ROOT/reference/qa/hermetic-mock-standard.md`, §3 (stages ④/⑤) and §5 rows 5/6/8/9/10. STOP and report a reference gap if missing.
2. **Declare module-level state** for this domain only (e.g. a toggle flag, a ledger list, a counter) — scoped narrowly to what this one scenario needs to observe an effect; never a second implementation of backend business logic (§3b).
3. **Add the write-mutation branch** — the `if` that matches the write request (method + path regex) and updates the declared state.
4. **Add the read-splice branch** — the `if` that matches the corresponding read request and returns a body reflecting the current state (either a computed status/fixture per §5 row 5, or the accumulated state spliced into a fixture body per §5 row 8/9/10).
5. **Register the reset** — add this state store's clear call inside `resetMockServerState()`. This step is not optional: a stateful store left out of reset leaks across scenarios and is a test-isolation bug, not a style nit.
6. Regenerate the fixtures map only if a new fixture file was introduced; otherwise this step is a no-op.
7. Run `flutter analyze` on the edited file.

## Rules

- Edit only the stage ④/⑤ region and `resetMockServerState()` — never touch stage ①/②/③/⑥/⑦.
- Keep the branch's regex consistent with any manifest entry that already exists for the same path (§3 stage ④ invariant) — a stateful branch always intercepts before the route table for its path.
- Never fabricate business logic beyond the minimum state the scenario observes.

## Output

Branch description (write path + read path), state key declared, and confirmation that the reset registration was added to `resetMockServerState()`.
