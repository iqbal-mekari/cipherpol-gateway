# Procedure — Sync Docs

> **This file is not a skill.** It has no frontmatter and therefore no invocation
> gate, so any caller can execute it by `Read`-ing it regardless of its own
> `disable-model-invocation` setting.
>
> Executed by:
> - `/developer-sync-docs` — standalone entry point, manual sync
> - `/developer-build-feature` — tail step after a build
> - `/developer-build-from-ticket` — tail step, non-interactive
>
> Callers must pass the **Input** below. Nothing here is auto-substituted —
> `$ARGUMENTS` is not expanded in a file that is `Read` rather than invoked.

## Input

| Input | Required | Meaning |
|---|---|---|
| `invocation` | yes | `auto` — this is a build/debug tail step. `manual` — the user ran `/developer-sync-docs`. Governs whether `off` stops the run. |
| `interactive` | yes | Whether this caller can run `AskUserQuestion`. `false` from CI/remote flows. |
| `run_dir` | no | Absolute path to the run to sync. Omit only when `invocation: manual` — Step 2 then resolves it. |
| `mode` | with `run_dir` | `feature` \| `debug` |
| `ticket_key` | no | Jira issue key. Callers that already know it pass it; otherwise Step 3 resolves it. |
| `run_hint` | no | Run slug or path from `$ARGUMENTS`. `manual` only. |
| `project_root` | yes | Absolute path to the repo being documented, from the caller's Working Context |
| `state_dir` | yes | `<project_root>/.claude/agentic-state`, from the same Working Context. This procedure never resolves the root itself — see `$CLAUDE_PLUGIN_ROOT/reference/aegis/working-context.md` |

## Orchestrator Contract

Only permitted direct operations:
- `Bash` — resolving run paths and reading the gate
- `Grep` — locating a `ticket_key` in the run's state files
- `AskUserQuestion` — run selection and mirror approval, only when `interactive: true`

Never write docs, ADRs, or `state.json` directly. All writing is delegated to `developer-docs-worker`.

## Step 1 — Resolve the Gate

Load and follow the detection skill:

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/aegis-detect-docs-sync/SKILL.md"
```

It returns `docs_sync` and `confluence_space`. This is the only place in the whole flow that either environment variable is read.

Then decide whether there is anything to do at all:

| `docs_sync` | `invocation` | Action |
|---|---|---|
| `off` | `auto` | **Stop here.** Report `docs sync off — skipped`. Do not spawn any agent, do not resolve a run, do not touch `state.json`. |
| `off` | `manual` | Continue, treating `docs_sync` as `auto` for the rest of this procedure. The user asked explicitly, and `off` suppresses only the automatic tail step. Report the override in Step 6. |
| `ask` / `auto` | either | Continue. |

Evaluating this **before** the spawn is the point of doing it here: a project with sync off pays nothing for the tail step.

## Step 2 — Resolve the Run

If the caller passed `run_dir`, use it with the caller's `mode` and go to Step 3.

Otherwise enumerate both run families:

```bash
find "<state_dir>/developer/feature-plans" -mindepth 1 -maxdepth 1 -type d 2>/dev/null
find "<state_dir>/developer/debug" -mindepth 1 -maxdepth 1 -type d 2>/dev/null
```

| Directory | `mode` |
|---|---|
| `feature-plans/<feature>/` | `feature` |
| `debug/<timestamp>-<slug>/` | `debug` |

`debug/` also holds loose `<timestamp>-<slug>.md` investigation files; `-type d` already excludes them.

If both listings are empty, report that there is nothing to sync and stop. Mention that `/developer-build-from-ticket` removes its run directory on completion, so runs from that flow cannot be re-synced.

If `run_hint` names a run, resolve it against both families and verify the directory exists. If it matches neither, report what was found and stop — never guess at a near-match.

Otherwise present the runs via `AskUserQuestion`, labelling each with the sync state read from `<run>/state.json`:
- `docs.synced: true` → `already synced <docs.updated_at>`
- no `docs` block, or no `state.json` → `never synced`

## Step 3 — Resolve ticket_key

If the caller passed `ticket_key`, use it. Otherwise `Grep` the run's `state.json` and `plan.md` for a Jira issue key — exactly one match, use it; none or several disagreeing, pass nothing. The worker treats it as optional and reports `jira: skipped`. Never interrupt the user for it.

## Step 4 — Decide What the Worker May Mirror

`developer-docs-worker` does not read the environment. Translate the resolved gate into its `mirror_remote` input:

| `docs_sync` (as resolved in Step 1) | `interactive` | `mirror_remote` |
|---|---|---|
| `auto` | either | `yes` |
| `ask` | `true` | `prepare` |
| `ask` | `false` | `no` |

## Step 5 — Sync

Spawn `developer-docs-worker` with:

```
run_dir: <resolved in Step 2>
mode: feature | debug
mirror_remote: yes | no | prepare
confluence_space: <resolved in Step 1, may be empty>
ticket_key: <only if Step 3 resolved one>
```

If `mirror_remote: prepare` and the report contains `### Pending Approval`, surface the prepared Confluence title/body and Jira comment via `AskUserQuestion`. On approval, re-invoke with the same inputs and `mirror_remote: yes`. On decline, keep the local docs and continue.

## Step 6 — Report

Relay the worker's `## Docs Result` block. Verify `<run_dir>/state.json` now carries `docs.synced: true`; if it does not, report `⚠ docs not synced` rather than reporting success.

If Step 1 overrode an `off` setting, say so explicitly — the user's configured default was bypassed and they should know.
