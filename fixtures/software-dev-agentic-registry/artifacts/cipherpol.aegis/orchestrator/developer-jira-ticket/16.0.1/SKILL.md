---
name: developer-jira-ticket
description: Create Jira tickets via Atlassian MCP — either a platform breakdown list under an epic, or a single ad-hoc bug/task/story ticket with or without an epic — fetches PRD and optional Figma context, generates requirement-focused descriptions.
user-invocable: true
disable-model-invocation: true
allowed-tools: Agent, AskUserQuestion
---

## Routing Contract

This skill is a pure router. Its only permitted direct operation:
- `AskUserQuestion` — mode detection only, when `$ARGUMENTS` doesn't make the mode clear

Never write files, call Jira APIs, or generate ticket content directly. All Jira operations are delegated to `developer-jira-ticket-worker`.

## Step 0 — Detect Mode

Parse `$ARGUMENTS`. Classify:

| Pattern | Mode |
|---|---|
| A breakdown list (multiple `[PLATFORM] [SCOPE] Title: duration` lines) | **breakdown** — platform breakdown under one epic (existing flow) |
| One ad-hoc bug/task/story request — single title, no breakdown list | **single** — one ticket, epic optional |
| No arguments, or mode not decidable from the text | Ask the user |

If mode cannot be determined, call `AskUserQuestion`:

```
question    : "Create tickets from a full platform breakdown under an epic, or one ad-hoc ticket?"
header      : "Ticket Mode"
multiSelect : false
options     :
  - label: "Breakdown",     description: "Multiple tickets under one epic, parsed from a platform breakdown list"
  - label: "Single ticket", description: "One ad-hoc bug, task, or story — epic optional"
```

## Arguments

`$ARGUMENTS` — optional. For **breakdown** mode, pass epic key, PRD source, and/or breakdown inline. For **single** mode, pass issue type (bug/task/story), title, and any context/epic key inline. If omitted, or the resolved mode's required fields are missing, the worker will ask interactively.

## Steps

Spawn `developer-jira-ticket-worker` with:

> mode: <breakdown|single>
> <$ARGUMENTS>
