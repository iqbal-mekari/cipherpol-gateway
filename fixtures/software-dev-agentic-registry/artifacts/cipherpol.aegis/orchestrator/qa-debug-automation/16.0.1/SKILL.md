---
name: qa-debug-automation
description: Debug a failing Patrol integration test — reproduces the failure, diagnoses via the live native tree, applies a fix, and re-validates. Use when a Patrol testcase or scenario fails, an element is not found, a tap does not navigate, or an assertion fails.
user-invocable: true
disable-model-invocation: true
allowed-tools: Bash, Read, Glob, AskUserQuestion, Agent
---

## Arguments

`$ARGUMENTS` — optional path to the failing Dart test file, and/or an error message.

## Steps

### 0 — Resolve the failing test path

If `$ARGUMENTS` contains a path under `integration_test/`, use it.

Otherwise:

```bash
find "$(git rev-parse --show-toplevel)/integration_test" -name "*.dart" 2>/dev/null
```

Call `AskUserQuestion` with the found files as candidates (label = relative path) to pick the failing test.

Verify the resolved path exists (`Glob`) — if it does not, report the mismatch and stop.

### 1 — Gather optional context

Capture any error message or device id already present in the conversation or `$ARGUMENTS`. Both are optional — do not block on their absence:
- Missing error message — the worker reproduces the failure directly via `patrol develop`.
- Missing device id — the worker resolves one via `patrol devices`.

### 2 — Spawn qa-debug-worker

Spawn `qa-debug-worker` via the Agent tool:

> **test_path:** <resolved absolute path>
>
> **error_message:** <captured message, or "none — reproduce via patrol develop">
>
> **device_id:** <captured id, or "none — resolve via patrol devices">
>
> Diagnose and fix the failure per the read → run → native-tree → fix → re-run loop. Record any newly discovered failure pattern in the project-local KB.

### 3 — Relay outcome

Relay:
- **Root cause** — the worker's one-line diagnosis
- **Diff** — the fix applied to the test file
- **Confirmation** — the final `patrol test` result
- **Failure pattern** — whether a new entry was appended to `.claude/agentic-state/qa/failure-patterns-local.md`, with a one-line summary if so
