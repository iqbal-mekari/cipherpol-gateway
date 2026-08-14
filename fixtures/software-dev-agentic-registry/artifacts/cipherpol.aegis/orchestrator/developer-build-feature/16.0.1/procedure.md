# Procedure — Build Feature

> **This file is not a skill.** It has no frontmatter and therefore no invocation
> gate, so any caller can execute it by `Read`-ing it regardless of its own
> `disable-model-invocation` setting.
>
> Executed by:
> - `/developer-build-feature` — standalone entry point
> - `/developer-plan-build-feature` — composite entry point (plan, then build)
> - `/developer-brainstorming` and `/developer-brainstorm-build-feature`
>
> Callers must pass the **Input** below. Nothing here is auto-substituted —
> `$ARGUMENTS` is not expanded in a file that is `Read` rather than invoked.

## Input

| Input | Meaning |
|---|---|
| `input_path` | Path to a **run directory** or a **plan/spec document** |
| `working_context` | *(optional)* An already-resolved Working Context from the caller. When absent, the Preflight below resolves one. |

## Preflight — Resolve Working Context

Run before anything else. Full protocol: `$CLAUDE_PLUGIN_ROOT/reference/aegis/working-context.md`.

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/aegis-resolve-context/resolve_context.py" \
  --taxonomy="$CLAUDE_PLUGIN_ROOT/reference/cipherpol.json" \
  --hint="<user message verbatim>"
```

Skip if the caller already passed a resolved Working Context — resolve once per
session, never twice. Hold `project_root`, `platform`, `cp1_slug`, and `state_dir`
and pass all four in every agent spawn and every included procedure.

On `source=ambiguous`, present the `candidate=` lines via `AskUserQuestion` (one
option each, `label` = project, `description` = `<platform> · <path>`) and re-run
with `--repo=<chosen>`. On an `error=` line with no candidates, tell the user to
run `/aegis-setup-cipherpol` and stop. Then echo:

```
▸ <project> · <platform> · <project_root>
```

## Orchestrator Contract

Only permitted direct operations:
- `Bash` — resolving and validating the input path
- `Read` — reading the plan doc

Never read source files, search the codebase, or write code. Scoping is delegated to the scope agent; implementation to worker agents.

## Step 1 — Resolve Input

If `input_path` is empty, stop:
> No input provided. Pass a run_dir or plan/spec document.

```bash
if [ -d "<input_path>" ]; then
  ls "<input_path>/plan.md" 2>/dev/null
elif [ -f "<input_path>" ]; then
  echo "<input_path>"
fi
```

- Directory → `plan_doc = <input_path>/plan.md`, `run_dir = <input_path>`
- File → `plan_doc = <input_path>`, `run_dir = dirname(<input_path>)`

If the resolved file does not exist, stop:
> Plan document not found at `<path>`.

Read `plan_doc`.

## Step 2 — Scope & Batch

Spawn an Agent with the following prompt, passing the full contents of `plan_doc`:

> You are a scoping agent. Review the plan/requirements below and decompose the work into execution batches.
>
> Rules:
> - If the steps are small and cohesive, return a single batch.
> - If the steps are large or span distinct layers/concerns, split into multiple batches — each independently executable.
> - Each batch may have multiple workers running in parallel. Worker types:
>   - `feature` — domain, data, pres, or app layer work
>   - `ui` — UI/widget/screen work only
> Return ONLY a YAML block in this exact shape:
>
> ```yaml
> batches:
>   - id: 1
>     description: "<what this batch covers>"
>     workers:
>       - type: feature
>         layer: domain|data|pres|app
>         focus: "<specific work for this worker>"
>       - type: ui
>         layer: ui
>         focus: "<specific work for this worker>"
> ```
>
> Plan doc:
> <plan_doc contents>

Parse the returned `batches` from the YAML block.

## Step 3 — Execute

Process each batch in `id` order.

**For each batch:**

**3a — Spawn all workers in the batch in parallel.** For each entry in `batch.workers`:
- `type: feature` → `developer-feature-worker`
- `type: ui` → `developer-ui-worker`

Prompt each worker:

> run_dir: \<run_dir\>
> batch: \<batch.id\> — \<batch.description\>
> layer: \<worker.layer\>
> focus: \<worker.focus\>

**3b — Checkpoint loop.** If a worker returns `## Context Checkpoint`, re-spawn it immediately with the same prompt. Repeat until it returns `## Layers Complete` (feature-worker) or `## Feature Complete` (ui-worker).

## Step 4 — Tests

Scan `plan_doc` for a test section (e.g. a heading containing "test", "unit test", or a table listing test classes). If one exists, extract the test targets listed there — call this `spec_tests`.

Ask the user:

> Tests are next. What would you like to do?
> 1. Write tests for all implemented files
> 2. Write tests for specific files (I'll tell you which)
> 3. Skip tests

If `spec_tests` is non-empty, add a fourth option before option 3:
> 3. Use the test plan from the spec (`<N>` test targets found)
> 4. Skip tests

- **Option 1** — collect every source file written across all batches and pass them all to `developer-test-worker`.
- **Option 2** — ask the user to list the files, then pass that list to `developer-test-worker`.
- **Option 3 (spec)** — pass `spec_tests` directly to `developer-test-worker`.
- **Skip** — stop here.

Invoke `developer-test-worker` with `target` set to the resolved file path(s).

## Step 5 — Docs Sync

Load the docs-sync procedure and follow it end to end:

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/developer-sync-docs/procedure.md"
```

Pass:

| Input | Value |
|---|---|
| `run_dir` | this run's directory |
| `project_root` | from this run's Working Context |
| `state_dir` | from this run's Working Context |
| `mode` | `feature` |
| `ticket_key` | if the run's plan/state names one, else omit |
| `invocation` | `auto` |
| `interactive` | `true` |

That procedure owns the docs-sync gate, the worker spawn, the approval round-trip, and the `state.json` verification. It stops before spawning anything when docs sync is off, so there is nothing to check here — do not read `CIPHERPOL_DOCS_SYNC` and do not spawn `developer-docs-worker` directly.

## Step 6 — Final Report

Summarize batches executed and tests written/skipped, then include the worker's `## Docs Result` status line (or the `⚠ docs not synced` note from Step 5).
