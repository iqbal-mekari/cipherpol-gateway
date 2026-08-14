---
name: qa-generate-mock
description: Scaffold or extend a hermetic mock backend (deterministic, network-free in-process HTTP mock server) for Patrol UI automation in a Flutter app. Detects an existing mock backend, routes scaffold vs extend, and gates on Gate M inventory approval before writing anything.
user-invocable: true
disable-model-invocation: true
allowed-tools: Bash, Read, Glob, AskUserQuestion, Agent
---

## Arguments

`$ARGUMENTS` — optional OpenAPI/Swagger spec path or URL, a captured-responses directory, a feature name, or a free-text endpoint description.

## Steps

### 0 — Detect existing mock backend

```bash
find "$(git rev-parse --show-toplevel)/integration_test" -name "mock_server.dart" -o -name "mock_control.dart" -o -name "manifest.json" -path "*fixtures/mock*" 2>/dev/null
```

Call `AskUserQuestion`:

```
question    : "A hermetic mock backend was found/not found. What would you like to do?"
header      : "Mode"
multiSelect : false
options     :
  - label: "Scaffold new mock backend",    description: "Bootstrap the harness from scratch (no existing mock backend, or start over)"
  - label: "Extend existing mock backend", description: "Add endpoints, fixtures, or stateful cases to the mock backend already in this repo"
```

If Step 0 found nothing, mark "Scaffold new mock backend" as the recommended default. If it found any of the three files, mark "Extend existing mock backend" as the recommended default. Either way, require an explicit answer before proceeding — never infer the mode from the find result alone.

### 1 — Gather mode input

**Scaffold:** if `$ARGUMENTS` is empty, call `AskUserQuestion`:

```
question    : "What is the basis for the initial fixtures?"
header      : "Basis"
multiSelect : false
options     :
  - label: "Captured responses directory", description: "Freeze real responses already saved to disk (capture-first, per the standard)"
  - label: "OpenAPI/Swagger spec",          description: "Synthesize fixtures from a spec path or URL"
  - label: "Dart response models",          description: "Synthesize fixtures from the app's own fromJson models"
```

**Extend:** if `$ARGUMENTS` is empty, call `AskUserQuestion`:

```
question    : "Which endpoints and case classes should this extension add?"
header      : "Scope"
multiSelect : false
options     :
  - label: "Describe inline",       description: "List the endpoints and case classes now (happy/empty/error/latency/sequenced/stateful/…)"
  - label: "Point at a spec/diff",  description: "Derive the new endpoints from an OpenAPI spec or a recent API change"
```

For each new endpoint gathered above, also gather its fixture source, per **capture-first precedence** (`hermetic-mock-standard.md` §10): a captured response file/directory (preferred), or synthesize-from-model/OpenAPI as a fallback that must be flagged for review.

### 2 — Spawn qa-mock-worker

Spawn `qa-mock-worker` via the Agent tool with the collected scalars inline — never inline file contents:

> **mode:** <scaffold | extend>
>
> **basis (scaffold only):** <captured-dir | openapi | dart-models>
>
> **spec_path (optional):** <path or URL, if provided>
>
> **feature:** <feature name, or "mock-backend" if none given>
>
> Discover the app's env/base-URL/session seams per `hermetic-mock-standard.md`, build the endpoint/fixture inventory, present Gate M (Mock Inventory Approval) before writing anything, then generate the mock backend per the standard, run the honesty gates, and report verified paths.

### 3 — Relay Gate M and loop

Relay the worker's Gate M presentation verbatim — the full discovery table AND the full inventory table, never a summary count — and wait for the user's explicit proceed/edit/cancel. Loop back to the worker on edit requests. Never progress silently past the gate.

### 4 — Relay completion and suggest next steps

Once the worker finishes, relay its written-file list and the three honesty-gate results (structural, semantic, contract-diff) verbatim.

Suggest:
- `/qa-generate-automation` — automate test cases mock-aware, arranging via `MockControl`
- `/qa-generate-testcase` — generate the test cases this mock backend will back, if none exist yet

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
