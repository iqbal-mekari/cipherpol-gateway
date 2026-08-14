---
name: developer-breakdown-requirement
description: Turn a requirement into Jira tickets — accepts a PRD, Figma UI stack, or nothing (elicited conversationally), clarifies scope through discussion until it converges, then produces either a multi-ticket breakdown under a parent, OR a single enriched ticket (scaffold an empty ticket or re-evaluate an already-built one). Writes local markdown and optionally creates or updates Jira.
user-invocable: true
disable-model-invocation: true
allowed-tools: Agent, AskUserQuestion, Bash, WebFetch
---

## Routing Contract

This skill is a pure router. Its only permitted direct operations:
- `Bash` — run-dir creation only
- `AskUserQuestion` — discussion and approval prompts defined in each step

Never read source files, fetch URLs directly, search the codebase, or write ticket files. All fetching, analysis, and file writing is delegated to agents.

## Step 0 — Resolve Working Context

Run before anything else. Full protocol: `$CLAUDE_PLUGIN_ROOT/reference/aegis/working-context.md`.

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/aegis-resolve-context/resolve_context.py" \
  --taxonomy="$CLAUDE_PLUGIN_ROOT/reference/cipherpol.json" \
  --hint="<user message verbatim>"
```

Hold `project_root`, `platform`, `cp1_slug`, and `state_dir` for the whole run and
pass all four in every agent spawn. On `source=ambiguous`, present the `candidate=`
lines via `AskUserQuestion` (one option each, `label` = project, `description` =
`<platform> · <path>`) and re-run with `--repo=<chosen>`. On an `error=` line with
no candidates, tell the user to run `/aegis-setup-cipherpol` and stop. Then echo:

```
▸ <project> · <platform> · <project_root>
```

## Step 1 — Choose Output Mode

First decide what the run produces. Call `AskUserQuestion`:

```
question    : "What should this run produce?"
header      : "Output"
multiSelect : false
options     :
  - label: "Break into multiple tickets", description: "Split a parent (Epic / Story / Task) into several child tickets"
  - label: "Scaffold / refine one ticket",  description: "Fill an empty ticket, or re-evaluate an already-built ticket's requirements — output is that one ticket"
```

**Break into multiple tickets** → `output_mode = breakdown`. The key you work with is a `parent_key` — children are filed under it.

**Scaffold / refine one ticket** → `output_mode = single`. The key you work with is the `target_key` — the ticket itself is enriched and updated in place.

> If `$ARGUMENTS` already makes the intent unambiguous (e.g. an explicit "break down" / "scaffold" verb), skip this prompt and set `output_mode` accordingly.

## Step 2 — Classify Inputs

Parse `$ARGUMENTS`. Collect:
- `target_key` — Jira issue key or URL (e.g. `PROJ-1234`) — **always required**. In `breakdown` mode this is the parent; in `single` mode it is the ticket to enrich.
- `prd_source` — Confluence URL/ID, Jira URL/key, generic URL, local `.md` path, or pasted text
- `figma_url` — optional Figma URL
- `figma_fetch_dir` — optional path to an existing figma fetch directory (from `/developer-fetch-figma`)

If a PRD source was not supplied, ask:

```
question    : "Do you have a PRD or requirement source?"
header      : "Requirement"
multiSelect : false
options     :
  - label: "Provide now",     description: "I'll give you a PRD source (Confluence, URL, file, or pasted text)"
  - label: "Talk it through", description: "No PRD yet — let's figure out the requirement together"
```

**Provide now** → `zero_input = false`. Collect `prd_source`.

**Talk it through** → `zero_input = true`, `prd_source = "(none)"`. The clarifying discussion that replaces the PRD happens in Step 8 — don't ask requirement questions here.

`target_key` is required in both cases. If not already provided, ask for it:
> "I still need the Jira key<if breakdown: ' to file tickets under'><if single: ' of the ticket to work on'>. What's the key or URL?"

**Single mode — existing local copy.** The user may already have fetched this ticket to a local `.md` file. If `$ARGUMENTS` includes a local `.md` path, set `existing_ticket_path` to it. Otherwise ask:

```
question    : "Do you already have this ticket fetched to a local file?"
header      : "Local copy"
multiSelect : false
options     :
  - label: "Yes — use it",  description: "Enrich the ticket file I already have, in place"
  - label: "No — fetch it",  description: "Pull the current ticket from Jira into a fresh run directory"
```

**Yes — use it** → ask for the path and set `existing_ticket_path`. This file is both the enrichment baseline and the write target — the run keeps everything in that file's directory instead of creating a new one. If the path is wrong, Step 3's resolver returns a `Doc Resolve Error` and the recovery prompt there lets the user re-enter it.

**No — fetch it** → leave `existing_ticket_path` unset; the ticket is fetched from Jira in Step 3 and written to a fresh run directory.

(`breakdown` mode never uses `existing_ticket_path` — it always writes new child files to a run directory.)

## Step 3 — Resolve Sources

Resolve the target so the strategist has the current ticket/parent content. The `source` for the target depends on whether a local copy exists:

- `breakdown` mode → `source: <target_key>`, `purpose: parent_key`
- `single` mode, `existing_ticket_path` set → `source: <existing_ticket_path>`, `purpose: target` (reads the user's local file — its content is the baseline, its frontmatter `type` becomes `ticket_type`; **no Jira fetch**, so local edits are preserved)
- `single` mode, no local copy → `source: <target_key>`, `purpose: target` (fetches the live ticket from Jira)

Spawn `developer-doc-resolve-worker` for the target always. Spawn a second one for `prd_source` **only if `zero_input` is false** — run both in parallel in a single `Agent` tool call when both apply.

**target worker:**
> source: \<target_key, or existing_ticket_path in single mode when set\>
> purpose: \<parent_key (breakdown) | target (single)\>

**prd_source worker (skip if `zero_input`):**
> source: \<prd_source\>
> purpose: prd_source

Read each `## Doc Resolve Result` or `## Doc Resolve Error` block:

- target result: extract `resolved_key` (canonical `target_key` going forward, when the source was a Jira key) and `title`. Store the `content`:
  - `breakdown` mode → store as `parent_context` (supplementary parent scope).
  - `single` mode → store `content` as `target_context` (current ticket content the strategist enriches) and `issue_type` as `ticket_type`. Whether it came from Jira or the local file, this is the current state captured before any edit. An `(empty — ...)` content means a scaffold case; populated content means re-evaluate. If `issue_type` is absent (local file with no frontmatter `type`), ask the user for the ticket type (Epic / Story / Task / Sub-task).

When no local copy exists, the write worker later materializes `target_context` into a local `TICKET-*.md`; when `existing_ticket_path` is set, that file already is the local copy and gets overwritten in place in Step 10.
- `prd_source` result (if run): store `content` as `prd_content` — the resolved PRD text passed to the strategist.

**If either worker returns `## Doc Resolve Error`:**

Call `AskUserQuestion` once per failed source:

```
question    : "Could not fetch <source> (<error>). How would you like to provide this?"
header      : "Fetch Failed"
multiSelect : false
options     :
  - label: "Paste content",     description: "I'll paste the text directly"
  - label: "Provide new URL",   description: "Try a different URL or path"
  - label: "Skip",              description: "Proceed without this source"
```

- **Paste content** → collect pasted text, use as `prd_content` / `target_context`.
- **Provide new URL** → collect new URL or path, re-spawn `developer-doc-resolve-worker` once. If it fails again, offer Paste or Skip only.
- **Skip** → proceed without that source. A failed `target_key` resolution cannot be skipped — it is required; re-prompt instead. In `single` mode a failed fetch also cannot be skipped: the current ticket content is needed to enrich and to diff on update.

## Step 4 — Optional Figma Fetch

Skip this step if `figma_fetch_dir` is already provided.

Call `AskUserQuestion`:

```
question    : "Do you want to include Figma designs?"
header      : "Figma"
multiSelect : false
options     :
  - label: "Yes — fetch now",          description: "Run /developer-fetch-figma inline to fetch frames"
  - label: "Yes — I have a fetch dir", description: "I already have a figma_fetch_dir path"
  - label: "No",                       description: "Proceed with requirement docs only"
```

**No** → set `figma_fetch_dir = "(none)"` and continue.

**Yes — I have a fetch dir** → ask: `"Paste the figma_fetch_dir path."` Collect as `figma_fetch_dir` and continue.

**Yes — fetch now** → execute the Figma-fetch workflow. Load its procedure — the shell expands `$CLAUDE_PLUGIN_ROOT`, so use Bash rather than `Read`:

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/developer-fetch-figma/procedure.md"
```

Follow it end to end with `arguments` = the Figma URLs collected from the user. When it completes, extract `figma_fetch_dir` from the `Fetch directory:` line in its output. Use as `figma_fetch_dir` and continue.

## Step 5 — Confirm Breakdown Level (breakdown mode only)

**Skip this step entirely in `single` mode** — the content shape is derived from the target ticket's own `ticket_type` (Sub-task → System Context; else → System Design).

In `breakdown` mode, call `AskUserQuestion`:

```
question    : "What is <target_key><if title is known: ' — <title>'>? This determines the ticket format produced."
header      : "Breakdown Level"
multiSelect : false
options     :
  - label: "Epic",          description: "Breaking an Epic into Stories / Tasks — each ticket gets a full System Design section"
  - label: "Story / Task",  description: "Breaking a Story or Task into Sub-tasks — each ticket gets a System Context pointer to the parent"
```

Store the answer as `breakdown_level`:
- **Epic** → `breakdown_level = epic_to_tickets`
- **Story / Task** → `breakdown_level = ticket_to_subtasks`

## Step 6 — Create Run Directory

**Skip this step if `existing_ticket_path` is set** (single mode with a local copy) — there is no new directory to create; the enriched ticket is written back to that file in Step 10, and its directory is the working location.

Otherwise create a run directory:

```bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
SLUG=$(echo "<target_key>" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')
run_dir="<state_dir>/developer/breakdown/${SLUG}-${TIMESTAMP}"
mkdir -p "$run_dir/tickets"
echo "$run_dir"
```

## Step 7 — Confirm Breakdown Strategy (breakdown mode only)

**Skip this step entirely in `single` mode** — there is no grouping to strategize; the output is one ticket.

In `breakdown` mode, present the default strategy for the confirmed `breakdown_level` and ask the user to confirm or override.

**If `breakdown_level = epic_to_tickets`**, show:

```
Default breakdown strategy (Epic → Stories / Tasks):

 1. State management — 1 ticket for all BLoC / ViewModel / Presenter + domain models, state classes, events
 2. Shared components — 1 ticket for all reusable widgets, design-system wrappers, cross-screen UI pieces
 3. Screens — 1 ticket per screen (UI, state-holder wiring, screen-specific components)
 4. Infrastructure — 1 ticket each for routing/DI setup, native iOS integration, native Android integration, etc.
```

**If `breakdown_level = ticket_to_subtasks`**, show:

```
Default breakdown strategy (Story / Task → Sub-tasks):

 1. Domain models — 1 sub-task for entities, DTOs, request/response types
 2. Repository + data source — 1 sub-task for interface, impl, remote/local data sources, mappers
 3. State management — 1 sub-task for BLoC / ViewModel / Presenter + state classes + events
 4. Shared components — 1 sub-task for reusable widgets and design-system wrappers scoped to this ticket
 5. Screens — 1 sub-task per screen (UI widget, state-holder wiring, screen-specific components)
 6. Routing / DI — 1 sub-task for route registration and dependency injection wiring
```

Call `AskUserQuestion`:

```
question    : "Use this breakdown strategy?"
header      : "Strategy"
multiSelect : false
options     :
  - label: "Use default",  description: "Apply the strategy above"
  - label: "Custom",       description: "Describe your own grouping rules"
```

**Use default** → pass the strategy text to the strategist as `breakdown_strategy`.

**Custom** → ask the user to describe their preferred grouping. Pass their description as `breakdown_strategy` instead.

## Step 8 — Clarify Loop

This step always runs, in both modes — its job is convergence on scope before any output is generated. For a resolved PRD it surfaces ambiguities; for `zero_input` it elicits the requirement; in `single` re-evaluate mode the strategist also explores the codebase to ground the discussion in what's actually built.

Spawn `developer-breakdown-strategist` (default `discuss` mode):

> output_mode: \<breakdown|single\>
> target_key: \<target_key\>            (passed as parent_key when breakdown)
> breakdown_level: \<breakdown_level, or "(n/a — single)"\>
> ticket_type: \<ticket_type, or "(n/a — breakdown)"\>
> prd_source: \<prd_content, or "(none — elicit conversationally)" if zero_input\>
> target_context: \<parent_context (breakdown) or target_context (single), or "(none)"\>
> figma_url: \<figma_url, or "(none)"\>
> figma_fetch_dir: \<figma_fetch_dir, or "(none)"\>
> breakdown_strategy: \<breakdown_strategy, or "(n/a — single)"\>
> zero_input: \<true|false\>

Read the `## Decision: discuss` block: `findings_summary`, `reasoning`, `questions`.

Show the findings and reasoning inline, then call `AskUserQuestion`:

```
question    : "<findings_summary>

               <reasoning>

               Questions:
               <for each question: "• <question>">

               How would you like to proceed?"
header      : "Clarify Scope"
multiSelect : false
options     :
  - label: "Answer",        description: "Provide answers or additional context"
  - label: "Converge now",  description: "Understanding is enough — generate the output"
```

**Answer** → the user provides free-text answers. Re-spawn `developer-breakdown-strategist` in default `discuss` mode with the original inputs **plus** the full discussion history and the user's latest answer (see Context Relay below). Do NOT use `SendMessage` — each round is a fresh agent spawn. Loop returns to the top of this step.

**Converge now** → re-spawn `developer-breakdown-strategist` with `mode: summarize` and the full discussion history. Its `## Decision: summarize` output is the initial `## Breakdown Proposal` — proceed to Step 9 with it as `current_proposal`.

### Context Relay Between Rounds

Each re-spawn must include the **full discussion history** so the strategist has continuity:

```
output_mode: <breakdown|single>
target_key: <target_key>
... (all other Step 8 spawn params unchanged) ...

Discussion history:
---
Round 1 — Strategist:
<strategist output from round 1>

Round 1 — User:
<user response from round 1>
---
Round 2 — Strategist:
<strategist output from round 2>

Round 2 — User:
<user response from round 2>
---
...

Latest user input:
<current user response>
```

## Step 9 — Confirm Proposal

Show `current_proposal`'s reasoning and ticket(s) inline before calling `AskUserQuestion`.

**breakdown mode** — render the full table:

```
Proposed breakdown: <summary>

Why this grouping:
<reasoning bullet points>

 #   Type      SP   Title
─────────────────────────────────────────────────────
 1   Story      3   ...
 2   Task       2   ...
 ...
```

**single mode** — render the one ticket's before/after intent:

```
Enriched ticket: <target_key> — <title>  (<Type>, <SP> SP)

What changed:
<reasoning bullet points>

<one-paragraph preview of the new Description + AC count>
```

Call `AskUserQuestion`:

```
question    : "Does this look right?"
header      : "<Ticket Breakdown | Enriched Ticket>"
multiSelect : false
options     :
  - label: "Approve",   description: "Write to local markdown"
  - label: "Revise",    description: "Change scope, split, merge, rename, or redirect"
  - label: "Cancel",    description: "Stop without writing anything"
```

**Approve** → proceed to Step 10.

**Cancel** → stop.

**Revise** → ask the user to describe the changes. Re-spawn `developer-breakdown-strategist` with `mode: summarize` plus:

> feedback: \<user's instructions verbatim\>
> previous_proposal: \<current_proposal, verbatim\>

Set `current_proposal` to the new `## Decision: summarize` output. Return to the top of Step 9 with the revised proposal.

## Step 10 — Write Ticket Files

Read `ticket_count` from `current_proposal`. In `single` mode `ticket_count` is always 1.

The write worker selects its file schema from `breakdown_level`. In `single` mode, derive the value it should receive from the target ticket's `ticket_type`:
- `Sub-task` → `ticket_to_subtasks` (Schema B — System Context)
- Epic / Story / Task → `epic_to_tickets` (Schema A — System Design)

Spawn `developer-ticket-write-worker` (for `breakdown` with >8 tickets, spawn one per ticket in parallel in a single Agent call; otherwise one worker):

> run_dir: \<run_dir, or "(n/a)" when output_path is set\>
> output_path: \<existing_ticket_path, only in single mode when set — omit otherwise\>
> parent_key: \<target_key\>
> prd_source: \<prd_source, or "(elicited via discussion)" if zero_input\>
> breakdown_level: \<breakdown_level (breakdown) or the value derived above (single)\>
> tickets: \<tickets list as JSON (single element in single mode)\>

Capture the written file path from the worker's confirmation — for single mode it is the sync worker's `ticket_file` in Step 11:
- with a local copy → `existing_ticket_path` (overwritten in place)
- without → `<run_dir>/tickets/TICKET-001.md`

Show the written path(s):

```
Written <N> ticket file(s):

  <path> — <title>
  ...
```

## Step 11 — Push to Jira (optional)

### breakdown mode

Call `AskUserQuestion`:

```
question    : "Push these tickets to Jira now?"
header      : "Jira"
multiSelect : false
options     :
  - label: "Yes",   description: "Create tickets under the parent via Atlassian MCP"
  - label: "Later", description: "Keep as local files — run /developer-jira-ticket when ready"
```

**Later** → show: `Tickets saved. Run /developer-jira-ticket and pass the parent key and the local ticket files when ready.`

**Yes** → spawn `developer-jira-ticket-worker` with:

> parent_key_key: \<target_key\>
> prd_source: \<prd_source, or "(elicited via discussion)" if zero_input\>
> figma_links: \<figma_url, or omit if none\>
> breakdown: \<tickets formatted as breakdown lines: "- [TYPE] Title: N days"\>

The worker will interactively ask for any missing Jira connection details (cloud_id, project_key).

### single mode

The target ticket already exists — this is an **update**, not a create. Call `AskUserQuestion`:

```
question    : "Update <target_key> in Jira with the enriched content now?"
header      : "Jira"
multiSelect : false
options     :
  - label: "Yes",   description: "Diff the local file against the live ticket and update on confirmation"
  - label: "Later", description: "Keep the local file — run /developer-push-tickets update mode when ready"
```

**Later** → show: `Local file saved at <path>. Run /developer-push-tickets with this file and <target_key> when ready.`

**Yes** → ask for `cloud_id` if not already known, then spawn `developer-sync-ticket-worker`:

> ticket_file: \<the local ticket path captured in Step 10 — `existing_ticket_path` if set, else `<run_dir>/tickets/TICKET-001.md`\>
> jira_key: \<target_key\>
> cloud_id: \<cloud_id\>

The sync worker fetches the live ticket, shows the diff, and updates only on the user's confirmation — never overwrites blind.

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
