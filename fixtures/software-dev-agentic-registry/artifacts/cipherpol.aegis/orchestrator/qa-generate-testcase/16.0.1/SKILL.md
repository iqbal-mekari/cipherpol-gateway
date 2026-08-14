---
name: qa-generate-testcase
description: Generate, regenerate, or impact-analyze mobile UI test cases from a Jira ticket, Confluence PRD, Figma design, or free-text description. Writes the canonical CSV under testcases/<feature>/ and gates on explicit approval before any automation step.
user-invocable: true
disable-model-invocation: true
allowed-tools: Bash, Read, AskUserQuestion, Agent
---

## Arguments

`$ARGUMENTS` — optional Jira URL, Confluence URL, Figma URL, free-text description, PR number, branch name, or diff ref.

## Steps

### 0 — Detect existing corpus

```bash
find "$(git rev-parse --show-toplevel)/testcases" -name "*_test_cases.csv" 2>/dev/null
```

If files exist, call `AskUserQuestion`:

```
question    : "Existing test case files found. What would you like to do?"
header      : "Mode"
multiSelect : false
options     :
  - label: "Create new test cases",   description: "Generate fresh cases for a new feature"
  - label: "Regenerate from changes", description: "Update an existing CSV based on a PR or diff"
  - label: "Impact analysis",         description: "Report which existing cases a diff affects, without rewriting the CSV yet"
```

If no files are found, ask the same question but mark "Create new test cases" as the recommended default (no corpus exists yet to regenerate or impact-analyze against) — still require an explicit answer before proceeding.

### 1 — Gather input for the chosen mode

**Create:** if `$ARGUMENTS` is empty, call `AskUserQuestion`:

```
question    : "What is the source for these test cases?"
header      : "Source"
multiSelect : false
options     :
  - label: "Jira ticket URL",       description: "Fetch requirements and acceptance criteria from Jira"
  - label: "Confluence PRD URL",    description: "Fetch requirements from a Confluence page"
  - label: "Figma design URL",      description: "Generate from screen designs and component states"
  - label: "Free-text description", description: "Describe the feature inline"
```

**Regenerate:** call `AskUserQuestion`:

```
question    : "What is the basis for regeneration?"
header      : "Basis"
multiSelect : false
options     :
  - label: "PR number",    description: "Diff a specific pull request"
  - label: "Branch diff",  description: "Compare the current branch against main"
  - label: "Local diff",   description: "Use uncommitted working-tree changes"
```

**Impact analysis:** call `AskUserQuestion`:

```
question    : "What diff should the impact analysis be based on?"
header      : "Diff Ref"
multiSelect : false
options     :
  - label: "Branch diff",  description: "Compare the current branch against main"
  - label: "PR number",    description: "Diff a specific pull request"
  - label: "Custom ref",   description: "Specify any git ref or commit range"
```

### 2 — Spawn qa-testcase-worker

Spawn `qa-testcase-worker` via the Agent tool with the collected scalars inline — never inline file contents:

> **Mode:** <create | regenerate | impact>
>
> **Input:** <$ARGUMENTS or collected source>
>
> **Basis (regenerate/impact only):** <PR number | branch diff | local diff | custom ref>
>
> Execute the full workflow per the canonical test-case standard. Write the CSV to `testcases/<feature>/<feature>_test_cases.csv`, update `testcases/registry.yaml` if a new feature is introduced (never invent a prefix, never renumber existing IDs), and present Gate 1 (Test Case Approval) before finishing.

### 3 — Relay Gate 1 and suggest next steps

Relay the worker's Gate 1 summary (counts, CSV preview) verbatim and wait for the user's explicit approval or edit requests — loop back to the worker on edit requests. Never progress silently past the gate.

On approval, suggest:
- `/qa-generate-automation` — turn the approved cases into Patrol tests
- `/qa-sync-testcase` — push the corpus to pokayoke

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
