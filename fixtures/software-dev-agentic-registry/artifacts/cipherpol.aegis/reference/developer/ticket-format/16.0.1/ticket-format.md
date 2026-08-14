# Ticket Format

> Author: Puras Handharmahua · 2026-06-15
> Related: developer-breakdown-strategist.md (proposal writer), developer-ticket-write-worker.md (file writer), developer-breakdown-requirement/SKILL.md (parser + orchestrator)

Single source of truth for two schemas used by the `/developer-breakdown-requirement` flow:
1. `## Breakdown Proposal` — returned by `developer-breakdown-strategist` (`mode: summarize`), parsed by the SKILL
2. `TICKET-NNN.md` — written by `developer-ticket-write-worker` to the run directory

## Breakdown Levels

There are two distinct breakdown operations:

| Level | Parent | Produces | System design |
|---|---|---|---|
| `epic_to_tickets` | Jira Epic | Story / Task tickets | Full `## System Design` per ticket |
| `ticket_to_subtasks` | Jira Story or Task | Sub-task tickets | `## System Context` referencing parent |

The breakdown strategist detects the level from the ticket types it proposes and emits `breakdown_level` in the proposal header. The write worker reads it to select the correct file schema.

---

## Breakdown Proposal Schema

Returned as the final output of `developer-breakdown-strategist` (`mode: summarize`). The SKILL parses `tickets` from this block.

```
## Breakdown Proposal

**Summary:** N tickets | X SP
**Breakdown Level:** epic_to_tickets | ticket_to_subtasks

| # | Type | Title | SP |
|---|---|---|---|
| 1 | Story | ... | 3 |
| 2 | Task  | ... | 2 |
...

## Ticket Details

### 1. <Title>
**Type:** Story|Task|Sub-task
**Story Points:** N
**Description:**
<1–3 sentences: what this ticket delivers and why, sourced from the PRD>

**System Design:**                    ← only for Story / Task (epic_to_tickets)
Feature Context: <1–2 sentences on what this screen/feature does>
Use Cases: <UseCaseName — purpose>, <UseCaseName — purpose>
API: <METHOD /path — RequestDto → ResponseDto>, ...
Data Model: <EntityName { field: type, ... }>, ...
Architecture: <ScreenClass / BlocClass → UseCaseName → RepositoryInterface → DataSource>
Data Flows:
  <FlowName>: <UserAction> → <BlocEvent> → <UseCase>.execute() → <Repo>.method() → <API> ← <Dto> ← <Entity> ← <State> ← UI renders <result>

**System Context:**                   ← only for Sub-task (ticket_to_subtasks)
Parent system design: <PARENT-KEY>
Relevant use cases: <UseCaseName>, <UseCaseName>
Relevant flows: <FlowName>, <FlowName>

**Acceptance Criteria:**
- [ ] <specific, testable criterion>
- [ ] <specific, testable criterion>
- [ ] <specific, testable criterion>

---

### 2. <Title>
...
```

### Breakdown Proposal Section Contracts

| Section | Required | Written by | Read by | Purpose |
|---|---|---|---|---|
| `**Summary:**` line | always | breakdown-strategist | SKILL (display) | Human-readable count and total SP |
| `**Breakdown Level:**` | always | breakdown-strategist | SKILL, ticket-write-worker | Selects which TICKET-NNN.md schema to apply |
| Summary table | always | breakdown-strategist | SKILL (parse tickets list) | Quick overview used to render the discussion table |
| `## Ticket Details` | always | breakdown-strategist | SKILL (parse each ticket object) | Full ticket data per ticket |
| `**Type:**` | always | breakdown-strategist | ticket-write-worker | Determines Jira issue type and ticket file frontmatter |
| `**Story Points:**` | always | breakdown-strategist | ticket-write-worker | Fibonacci SP written to file frontmatter |
| `**Description:**` | always | breakdown-strategist | ticket-write-worker | PRD-sourced context written to `## Description` section |
| `**System Design:**` | epic_to_tickets only | breakdown-strategist | ticket-write-worker | Full system design — API, data model, architecture, flows |
| `**System Context:**` | ticket_to_subtasks only | breakdown-strategist | ticket-write-worker | Pointer to parent system design + relevant use cases and flows |
| `**Acceptance Criteria:**` | always | breakdown-strategist | ticket-write-worker | Testable criteria written to `## Acceptance Criteria` section |

---

## TICKET-NNN.md Schemas

Written by `developer-ticket-write-worker` to `<run_dir>/tickets/TICKET-NNN.md`. Index is zero-padded to 3 digits.

### Schema A — Story / Task (`epic_to_tickets`)

```markdown
---
type: Story|Task
story_points: N
breakdown_level: epic_to_tickets
---

# <Title>

## Description

<description>

## System Design

### Feature Context

<1–2 sentences on what this screen/feature does and why it exists>

**Use Cases in scope:**
- `<UseCaseName>` — <one-line purpose>

### API Design

| Method | Endpoint | Request | Response |
|---|---|---|---|
| GET | `/path` | — | `ResponseDto` |

### Data Model

```
<EntityName>
  - <field>: <type>
```

```
<DtoName>
  - <field>: <type>    // "<json_key>" if differs
```

### High-Level Architecture

```
Presentation: <ScreenClass>, <BlocClass/ViewModel>
  ↓
Domain: <UseCase1>, <UseCase2> → <RepositoryInterface>
  ↓
Data: <RepositoryImpl> → <RemoteDataSource> → REST API
```

### Data Flows

**<FlowName — e.g. "Load X", "Submit X", "Delete X">:**
```
<UserAction>
  → <BlocClass>.add(<Event>)
      → <UseCaseName>.execute(<input>)
          → <RepositoryInterface>.<method>()
              → <DataSource>.<method>() → <METHOD> <endpoint>
          ← <EntityName>
      ← <StateClass>(<data>)
  ← UI renders <result>
```

## UI Stack

<Per-screen UIStack sections — component hierarchy, states, design tokens, interactions. One ### heading per UIStack file.>

## Acceptance Criteria

- [ ] <criterion>
- [ ] <criterion>

## References

- Parent: <parent_key>
- PRD: <prd_source>
```

---

### Schema B — Sub-task (`ticket_to_subtasks`)

```markdown
---
type: Sub-task
story_points: N
breakdown_level: ticket_to_subtasks
---

# <Title>

## Description

<description>

## System Context

> Full system design: see **<PARENT-KEY>**

**Relevant use cases:** `<UseCaseName>`, `<UseCaseName>`
**Relevant flows:** <FlowName>, <FlowName>

## UI Stack

<UIStack sections relevant to this sub-task only — component hierarchy, states, design tokens, interactions.>

## Acceptance Criteria

- [ ] <criterion>
- [ ] <criterion>

## References

- Parent: <parent_key>
- PRD: <prd_source>
```

---

### TICKET-NNN.md Section Contracts

| Section | Schema | Written by | Read by | Purpose |
|---|---|---|---|---|
| frontmatter (`type`, `story_points`, `breakdown_level`) | both | ticket-write-worker | developer-jira-ticket-worker | Machine-readable metadata for Jira creation |
| `# <Title>` | both | ticket-write-worker | user, developer-jira-ticket-worker | Ticket summary line |
| `## Description` | both | ticket-write-worker | user, developer-jira-ticket-worker | PRD-sourced context for the implementer |
| `## System Design` | A only | ticket-write-worker | implementer, AI builder | Full architecture reference — API, data model, layer diagram, data flows |
| `## System Context` | B only | ticket-write-worker | implementer, AI builder | Pointer to parent + scoped use cases and flows — avoids duplication |
| `## UI Stack` | both (screen tickets) | ticket-write-worker | implementer, AI builder | Component hierarchy and design tokens for UI-focused tickets |
| `## Acceptance Criteria` | both | ticket-write-worker | user, developer-jira-ticket-worker | Testable done-criteria |
| `## References` | both | ticket-write-worker | user | Traceability — links ticket back to parent and PRD source |
