---
name: developer-push-tickets
description: Push local ticket files to Jira — either create fresh tickets under an epic from a run directory, or update an existing Jira ticket with the content of a local TICKET-NNN.md file.
user-invocable: true
disable-model-invocation: true
allowed-tools: Agent, AskUserQuestion, Bash, Read
---

## Routing Contract

This skill is a pure router. Its only permitted direct operations:
- `Bash` — detect run dir contents only
- `Read` — only for explicit local file paths passed as formal arguments
- `AskUserQuestion` — mode detection and confirmation prompts defined in each step

Never write files, call Jira APIs, or modify ticket content directly. All Jira operations are delegated to workers.

## Step 0 — Detect Mode

Parse `$ARGUMENTS`. Classify:

| Pattern | Mode |
|---|---|
| Path to a directory containing `TICKET-*.md` files | **create** — push all local tickets as new Jira issues |
| `TICKET-*.md` file path + Jira key (e.g. `PROJ-123`) | **update** — sync local file content to an existing Jira ticket |
| Jira key only (e.g. `PROJ-123`) | **update** — ask for the local file to sync from |
| No arguments | Ask the user which mode |

If mode cannot be determined from arguments, call `AskUserQuestion`:

```
question    : "What would you like to do?"
header      : "Push Mode"
multiSelect : false
options     :
  - label: "Create fresh",      description: "Push local TICKET-NNN.md files as new Jira tickets under an epic"
  - label: "Update existing",   description: "Sync a local ticket file to an existing Jira ticket"
```

## Step 1 — Gather Missing Inputs

### Create mode

Required:
- `tickets_dir` — path to directory containing `TICKET-*.md` files (e.g. `<run_dir>/tickets/`)
- `parent_key` — Jira parent key: an epic key (e.g. `PROJ-1234`) to create Stories/Tasks, or a Story/Task key (e.g. `PROJ-456`) to create Sub-tasks
- `cloud_id` — Atlassian cloud hostname (e.g. `yourcompany.atlassian.net`)
- `project_key` — Jira project key (e.g. `PROJ`)

Verify the directory contains ticket files:
```bash
ls "<tickets_dir>"/TICKET-*.md 2>/dev/null
```

If empty, stop: "No TICKET-*.md files found in `<tickets_dir>`."

List found files and ask for confirmation before spawning workers:

```
question    : "Found N ticket(s) in <tickets_dir>. Push all to Jira under <parent_key>?"
header      : "Confirm Push"
multiSelect : false
options     :
  - label: "Push all",  description: "Create all N tickets as new Jira issues"
  - label: "Cancel",    description: "Stop without pushing"
```

**Cancel** → stop.

**Push all** → proceed to Step 2 (Create).

### Update mode

Required:
- `ticket_file` — absolute path to local `TICKET-NNN.md`
- `jira_key` — existing Jira ticket key (e.g. `PROJ-456`)
- `cloud_id` — Atlassian cloud hostname

Ask for any missing values before proceeding.

Proceed to Step 2 (Update).

## Step 2 — Execute

### Create mode

Check ticket count from the `ls` output.

**If count ≤ 8** — spawn 1 `developer-push-new-tickets-worker`:

> tickets_dir: \<tickets_dir\>
> parent_key: \<parent_key\>
> cloud_id: \<cloud_id\>
> project_key: \<project_key\>

**If count > 8** — read each `TICKET-*.md` file path, then spawn one `developer-push-new-tickets-worker` per ticket in parallel:

> ticket_file: \<absolute path to single TICKET-NNN.md\>
> parent_key: \<parent_key\>
> cloud_id: \<cloud_id\>
> project_key: \<project_key\>

Wait for all workers. Show summary:

```
Created <N> tickets:
  ✓ PROJ-5100 — <title>
  ✓ PROJ-5101 — <title>
  ...
```

### Update mode

Spawn 1 `developer-sync-ticket-worker`:

> ticket_file: \<ticket_file\>
> jira_key: \<jira_key\>
> cloud_id: \<cloud_id\>

Wait for the worker. Show result.

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
