---
name: qa-generate-automation
description: Generate Patrol Dart automation (testcases + scenarios) from an approved test case CSV. Writes files under integration_test/testcases/ and integration_test/scenarios/ in the downstream project.
user-invocable: true
disable-model-invocation: true
allowed-tools: Bash, Read, Glob, AskUserQuestion, Agent
---

## Arguments

`$ARGUMENTS` — optional path to a test case CSV.

## Steps

### 0 — Locate input CSV

If `$ARGUMENTS` points to an existing `.csv` file, use it directly.

Otherwise:

```bash
find "$(git rev-parse --show-toplevel)/testcases" -name "*_test_cases.csv" 2>/dev/null
```

- **None found** — tell the user to run `/qa-generate-testcase` first and stop.
- **Multiple found** — call `AskUserQuestion` (one option per CSV, label = filename) to pick the input.
- **One found** — use it directly.

### 1 — Confirm scope

Call `AskUserQuestion`:

```
question    : "Which test cases should be automated?"
header      : "Scope"
multiSelect : false
options     :
  - label: "Smoke tests only", description: "Only rows tagged \"smoke\" in the tags column"
  - label: "All test cases",   description: "Every row in the CSV"
```

### 2 — Check device availability

```bash
patrol devices
```

If no device or emulator is listed, tell the user to start an emulator/simulator and stop.

### 2.5 — Detect mock backend (hard prerequisite)

```bash
find "$(git rev-parse --show-toplevel)/integration_test/helpers" -name "mock_server.dart" 2>/dev/null
```

The hermetic mock backend is a hard prerequisite for this skill — UI automation must always be authored and run against it, never against a live/production backend.

- **Found** — proceed to Step 3.
- **Not found** — do not proceed to Step 3 under any circumstance. Call `AskUserQuestion`:

```
question    : "No hermetic mock backend was found. Automation must be authored and run against a mock backend — how should we proceed?"
header      : "Mock Backend Required"
multiSelect : false
options     :
  - label: "Run /qa-generate-mock first (Recommended)", description: "Stop here and generate the hermetic mock backend before automating"
  - label: "Cancel",                                    description: "Stop without generating automation"
```

  - **Run `/qa-generate-mock` first** — stop this skill and tell the user to re-run `/qa-generate-automation` once `/qa-generate-mock` has finished generating the mock backend.
  - **Cancel** — stop entirely.

### 3 — Spawn qa-automation-worker

Spawn `qa-automation-worker` via the Agent tool with the CSV path only — never inline CSV content:

> **csv_path:** <absolute path to selected CSV>
>
> **scope:** <smoke-only | all>
>
> **device:** <device id from step 2>
>
> **mock_backend:** Hermetic mock backend confirmed present at `integration_test/helpers/mock_server.dart` — mock-first authoring is mandatory for this run; every automated flow must be authored and executed against this mock backend.
>
> Triage each row, present Gate 2 (Mapping Table Confirmation), then write Patrol Dart testcases and scenarios per `patrol-standard.md`. Validate every file via `patrol develop` before reporting done.

### 4 — Relay Gate 2 and final report

Relay the worker's Gate 2 mapping table verbatim and wait for explicit confirmation before it writes any Dart — loop back to the worker on adjustment requests. Never let it proceed past the gate silently.

Once the worker finishes, relay its final file list (testcases + scenarios written, validation results). If any test fails later, suggest `/qa-debug-automation`.

## Gate Handling

Agents cannot ask the user anything. `AskUserQuestion` is stripped from every subagent's
tool set regardless of what its `tools:` frontmatter declares — verified empirically, see
`docs/initiatives/orchestrator-composition-initiative.md`. You have it; they do not.

So whenever an agent you spawned returns a `## Gate Pending` block, **you** own that question:

1. Show its `context:` verbatim — never paraphrase, summarise, or truncate it.
2. Put its `question:` to the user with its `options:` via `AskUserQuestion`.
3. Re-invoke the same agent with the original inputs plus the user's decision.

Never answer on the agent's behalf, and never relay a `## Gate Pending` block as if it were
an ordinary report and carry on — that silently bypasses the gate it exists to enforce.
