---
name: developer-rfc
description: Generate an RFC and ticket breakdown from a Jira Epic + PRD + optional Design. Fetches inputs, runs the Clean Architecture convergence planning loop, then writes <epic-slug>-rfc.md and <epic-slug>-breakdown.md.
user-invocable: true
disable-model-invocation: true
allowed-tools: Bash, Read, AskUserQuestion, Agent
---

## Arguments

`$ARGUMENTS` — Jira Epic key (optional). Example: `PROJ-123`.

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

## Step 1 — Resolve Jira Input

If `$ARGUMENTS` is empty, call `AskUserQuestion`:

```
question    : "Which Jira Epic should this RFC be based on?"
header      : "Epic"
multiSelect : false
options     :
  - label: "Enter Epic key", description: "e.g. PROJ-123"
```

Use the provided value as `<epic-key>`.

## Step 2 — Fetch Epic

Use the available Jira MCP tool. Prefer in order: `getJiraIssue`, `mmpa_get_jira`.

If neither is available, stop with a clear message.

Extract:
- `summary` — ticket title
- `description` — full body
- `issuetype`, `labels`, `components`
- Acceptance criteria — look for `## AC`, `## Acceptance Criteria`, or `h2. AC` sections

## Step 3 — Fetch PRD and Design

Call `AskUserQuestion` (batch both questions):

```
question    : "Provide the PRD Confluence URL for this Epic."
header      : "PRD"
multiSelect : false
options     :
  - label: "Paste URL", description: "Confluence page URL"
  - label: "No PRD — use Epic description only", description: "Skip Confluence fetch"

question    : "Is there a Figma design for this Epic?"
header      : "Design"
multiSelect : false
options     :
  - label: "Yes — paste Figma URL", description: "Design will be included in RFC context"
  - label: "No design", description: "Skip design input"
```

- If PRD URL provided → fetch via `mmpa_get_confluence_page`, read staging file, extract `.content`
- If Figma URL provided → fetch via `mcp__Figma__get_figma_data`
- Hold all fetched content inline — do not write to disk

## Step 4 — Derive Planning Inputs

Inline — do not spawn an agent:

| Input | Rule |
|---|---|
| `feature` | Epic key + slugified summary, lowercased, hyphens. Example: `proj-123-user-profile` |
| `new-or-update` | `issuetype == Bug` or summary contains fix/update/change/modify → `update`; otherwise → `new` |
| `operations` | Scan AC + description for GET/list, GET/single, POST/create, PUT/update, DELETE. Default to all when ambiguous. |
| `separate-ui-layer` | Detect from labels/components (ios/android/flutter → `true`; web → `false`). Default `true`. |
| `platform` | Detect from labels, components, or project key prefix. If undetectable, call `AskUserQuestion` to resolve. |

## Step 5 — Gather Intent (Non-Interactive)

Spawn `developer-feature-intent-strategist` with mode `gather-intent-prefilled`:

> **Mode: gather-intent-prefilled**
>
> **Pre-filled intent (do not ask for any of these):**
> - feature: `<derived feature name>`
> - new-or-update: `<new|update>`
> - operations: `<comma-separated list>`
> - separate-ui-layer: `<true|false>`
> - platform: `<platform>`
>
> **Epic context:**
> <epic summary + description + AC>
>
> **PRD context:**
> <prd content, or "None — use Epic description only.">
>
> **Design context:**
> <figma content, or "None provided.">

Wait for `Decision: spawn-planners`. Initialize:
- `visited` = []
- `all_findings` = []
- `round` = 1

## Step 6 — Planning Convergence Loop

Repeat until the strategist returns `Decision: converged` or `Decision: blocked`.

### 6a — Spawn planners for this round

From the current `Decision: spawn-planners` block, spawn each listed planner **in parallel**:

- `developer-domain-planner` — if `domain` in spawn list
- `developer-data-planner` — if `data` in spawn list
- `developer-pres-planner` — if `pres` in spawn list
- `developer-app-planner` — if `app` in spawn list

Pass to each planner: feature name, platform, module-path (from strategist output).

Wait for all planners to complete. Add spawned layers to `visited`. Append findings to `all_findings`.

### 6b — Send findings to strategist

Spawn `developer-feature-convergence-strategist`:

> **Mode: process-findings**
>
> Round: <N>
> Visited layers: <comma-separated>
>
> **Accumulated Findings:**
> <all_findings content>

- **`Decision: spawn-planners`** → increment `round`, go to 6a
- **`Decision: synthesized`** → plan.md and context.md are already written; extract `run_dir`, skip Step 7, proceed directly to Step 8
- **`Decision: blocked`** → call `AskUserQuestion` with the strategist's question and options, send the answer back as a follow-up `process-findings` call, re-evaluate

**Max rounds guard:** If `round` reaches 4 without convergence, surface to the user:
> "RFC planning could not converge after 3 rounds. Open questions: <list from last blocked decision>. Please clarify and retry."

Stop.

## Step 7 — Synthesize Plan (fallback only)

> **When reached:** This step is not reached in the normal convergence path — `Decision: synthesized` from 6b means plan.md and context.md are already on disk and synthesis happened inline within the strategist.

## Step 8 — Write RFC and Breakdown

Create the output directory:

```bash
mkdir -p "<state_dir>/developer/rfc"
```

Read `plan.md` and `context.md` from `run_dir` (extracted in Step 6b). Then spawn `developer-rfc-writer`:

> **Epic key:** <epic-key>
> **Epic slug:** <feature>
>
> **Epic content:**
> <summary + description + AC>
>
> **PRD content:**
> <prd content or "None">
>
> **Design content:**
> <figma content or "None">
>
> **plan.md:**
> <content>
>
> **context.md:**
> <content>

Wait for `developer-rfc-writer` to complete. Report the output file paths to the user.
