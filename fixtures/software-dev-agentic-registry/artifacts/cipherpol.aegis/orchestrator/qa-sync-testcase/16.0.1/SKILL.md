---
name: qa-sync-testcase
description: Sync the canonical testcases/ CSVs into the pokayoke SDET platform — idempotent upsert-by-id, dry-run by default. Use when asked to push, sync, or upload test cases to pokayoke or SDET.
user-invocable: true
disable-model-invocation: true
allowed-tools: Bash, Read, AskUserQuestion, Agent
---

## Arguments

`$ARGUMENTS` — optional `--apply` flag; otherwise the sync runs as a dry-run.

## Steps

### 0 — Preconditions

```bash
test -f "$(git rev-parse --show-toplevel)/testcases/registry.yaml" && echo FOUND || echo MISSING
```

If `MISSING`, stop: this is not a testcase-managed project — there is no `testcases/registry.yaml` to read `project_id`, prefixes, or sync exclusions from.

Confirm the pokayoke MCP tools (e.g. `mcp__pokayoke-mcp__list_projects`) are available. If they are not, point the user to the authentication flow documented in `$CLAUDE_PLUGIN_ROOT/reference/qa/pokayoke-integration.md` and stop.

### 1 — Determine mode

If `$ARGUMENTS` contains `--apply`, or the user has explicitly confirmed they want to apply changes in this conversation, set mode to `apply`. Otherwise default to `dry-run`.

### 2 — Spawn qa-sync-worker

Spawn `qa-sync-worker` via the Agent tool:

> **mode:** <dry-run | apply>
>
> Validate the corpus, build the remote id→dbId index, plan the diff (CREATE / UPDATE / SKIP), and — in `apply` mode only — write the changes. Report per the algorithm in `pokayoke-integration.md`.

Pass no `confirmed_deletes` on this first spawn — nothing is authorised for deletion yet.

### 2b — Delete confirmation gate

The worker cannot ask anything itself; `AskUserQuestion` is stripped from every subagent (see `qa-gates.md`). If its report contains a `## Gate Pending` block with `gate: delete-confirm`, **you** own the confirmation:

1. Show the block's `context` rows verbatim — id, title, and why each is a delete candidate.
2. Confirm **per id** via `AskUserQuestion`, never as a single batch approval. Deleting from pokayoke is an outward-facing, hard-to-reverse write against a shared platform.
3. Re-invoke `qa-sync-worker` with the same `mode` plus `confirmed_deletes: [<only the ids the user confirmed>]`.

If the user declines every id, do not re-invoke — report the candidates as left in place.

### 3 — Relay report

Relay the worker's report table (Created / Updated / Unchanged / Remote-duplicates / Validation-skipped) and the list of soft-delete candidates (present remotely, absent locally — never auto-deleted).

If `mode` was `apply`, relay the mandatory idempotency check (second dry-run pass) — a nonzero `Created` count there means stop and investigate; do not re-apply.

If `mode` was `dry-run`, offer to re-run with `--apply` once the user reviews the plan.
