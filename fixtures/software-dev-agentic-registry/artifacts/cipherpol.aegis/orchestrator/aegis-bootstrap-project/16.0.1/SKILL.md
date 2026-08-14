---
name: aegis-bootstrap-project
description: Bootstrap a new mobile project with golden-path dependencies read live from the mobile-dependency-catalog — creates the project, pins catalog versions, applies SDK constraints, and scaffolds the Clean Architecture skeleton.
allowed-tools: Bash, AskUserQuestion, Agent
user-invocable: true
disable-model-invocation: true
---

## Arguments

`$ARGUMENTS` — optional project name (snake_case). All other inputs are gathered interactively.

## Golden-Path Categories

Category keys reference `golden_paths.yaml` in the catalog — the catalog decides which package is golden; this skill never names packages.

- **Core (always included):** `dependency_injection`, `networking`, `state_management`, `serialization`, `logging`
- **Extras (user picks):** `local_storage`, `analytics`, `crash_reporting`, `image_loading`, `push_notifications`

## Steps

0. **Route — resume vs new.** Once `project_name` is known (from `$ARGUMENTS`, or after Step 1): if `.claude/agentic-state/runs/aegis/bootstrap-<project_name>/` already exists, ask the user: **resume** (re-spawn the worker with the same `context.md` inputs — its preconditions will skip or flag whatever already exists) or **restart** (delete the run directory and, after explicit confirmation, the partially created `<target_dir>/<project_name>`, then proceed as new).
1. **Gather inputs.** Use AskUserQuestion for anything missing:
   - `project_name` — snake_case (from `$ARGUMENTS` if given)
   - `org` — reverse-domain organization id (e.g. `com.mekari`)
   - `target_dir` — parent directory for the new project (default: current directory)
   - `platform` — default `flutter` (the only platform with an `aegis-create-project-scaffold` contract skill today)
2. **Pick extras.** AskUserQuestion (multi-select) over the extras list above. Core categories are not asked — they are always included.
3. **Resolve the catalog URL.** `$MOBILE_DEP_CATALOG_URL` if set, else `https://bitbucket.org/mid-kelola-indonesia/mobile-dependency-catalog.git`.
4. **Create the run directory** at `.claude/agentic-state/runs/aegis/bootstrap-<project_name>/` (relative to the current directory) and write `context.md` recording every gathered input.
5. **Execute.** Spawn `aegis-bootstrap-worker` with:

   > Bootstrap a new `<platform>` project.
   > - `project_name`: `<project_name>`
   > - `org`: `<org>`
   > - `target_dir`: `<absolute target_dir>`
   > - `platform`: `<platform>`
   > - `categories_core`: `dependency_injection, networking, state_management, serialization, logging`
   > - `categories_extra`: `<selected extras, comma-separated — or "none">`
   > - `catalog_url`: `<resolved catalog URL>`
   > - `run_dir`: `<absolute run directory path>`

6. **Report.** Relay the worker's report verbatim — including the catalog commit, per-category package/version table, any categories the catalog offers that were not requested, and the verification result. If the worker reports a BLOCKING finding (catalog unreachable, golden package without a version pin), surface it and stop — never improvise a version.
