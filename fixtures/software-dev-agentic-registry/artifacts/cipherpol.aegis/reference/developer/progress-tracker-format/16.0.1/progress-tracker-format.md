# Progress Tracker Format

> Author: Puras Handharmahua · 2026-06-16
> Related: developer-track-progress-gather-worker.md (producer), developer-track-progress-write-worker.md (consumer), developer-track-progress/SKILL.md and developer-groom-ticket/SKILL.md (orchestrators)

Single source of truth for two schemas used by the `/developer-track-progress` flow:
1. `## Context Block` — assembled by the orchestrator (`SKILL.md`): gather-worker contributes `TICKET_PATH`, `TICKET_ID`, `ACCEPTANCE_CRITERIA`; orchestrator adds session fields via `AskUserQuestion`. Consumed by `developer-track-progress-write-worker`.
2. `## Progress Tracker Section` — written by `developer-track-progress-write-worker` into the ticket `.md` file

> **Legacy heading.** Before 2026-07-22 this section was titled `# Session Adjustment — <date>`. Tickets written by earlier versions still carry that heading. The write-worker recognizes both and replaces a legacy block in place, so an old ticket is upgraded to `# Progress Tracker` on its next write. Never append a new section alongside a legacy one.

---

## Context Block Schema

Assembled by the orchestrator and passed verbatim as the `context` input to `developer-track-progress-write-worker`. The gather-worker produces the first three fields; the orchestrator fills in the session fields from user answers.

The gather-worker also returns `TRACKER_STATE`, `HIGHEST_PHASE`, `EXISTING_PHASES`, and `OPEN_QUESTION_COUNT`. Those are **orchestrator-only** — they exist so the orchestrator can decide `PHASE_MODE` and warn about a legacy heading. Do not forward them in the context block; the write-worker re-reads the file itself and would otherwise be trusting a stale snapshot.

```
TICKET_PATH: <absolute path to the .md file>
TICKET_ID: <e.g. TICKET-123>
ACCEPTANCE_CRITERIA:
<one line per AC item, original text preserved>
END_AC
PROGRESS: <narrative of what was implemented this session>
PHASE_MODE: <new | continue>
PHASE_NAME: <short label for this session's phase — required when PHASE_MODE is new>
DECISIONS: <decisions made, or "none">
OPEN_QUESTIONS: <unresolved questions or blockers, or "none">
RESOLVED_QUESTIONS: <previously open questions answered this session, or "none">
STATUS: <current development status, e.g. In Progress>
COMPLETED_ITEMS: <AC items confirmed done this session, or "none">
COMPLETED_WORK_ITEMS: <work items from existing phases finished this session, or "none">
BUGS: <bugs found this session, or "none">
```

### Context Block Field Contracts

| Field | Required | Written by | Read by | Purpose |
|---|---|---|---|---|
| `TICKET_PATH` | always | gather-worker | write-worker | Identifies which file to edit |
| `TICKET_ID` | always | gather-worker | write-worker | Used in the confirmation output line |
| `ACCEPTANCE_CRITERIA` … `END_AC` | always | gather-worker | write-worker | AC items copied verbatim into the Progress Tracker checklist |
| `PROGRESS` | always | orchestrator | write-worker | Source for `## Progress` narrative and for this phase's work items |
| `PHASE_MODE` | always | orchestrator | write-worker | `new` → open a new phase for this session's work. `continue` → add to / update the highest-numbered existing phase. See Phase Rules |
| `PHASE_NAME` | when `PHASE_MODE: new` | orchestrator | write-worker | Short label for the new phase, e.g. `Error handling`. Never a number — the write-worker assigns that |
| `DECISIONS` | always | orchestrator | write-worker | **New** decisions this session. Merged with existing ones, never replacing them; section omitted only when the value is "none" *and* no prior decisions exist |
| `OPEN_QUESTIONS` | always | orchestrator | write-worker | **New** unresolved questions this session. Merged with existing unresolved ones |
| `RESOLVED_QUESTIONS` | always | orchestrator | write-worker | Previously listed open questions answered this session — marked `- [x]` rather than deleted |
| `STATUS` | always | orchestrator | write-worker | Written verbatim to `## Status` |
| `COMPLETED_ITEMS` | always | orchestrator | write-worker | Used to mark AC checklist items `- [x]`; "none" leaves all unchecked |
| `COMPLETED_WORK_ITEMS` | always | orchestrator | write-worker | Work items in **earlier** phases finished this session — lets prior phases be ticked off without being rewritten |
| `BUGS` | always | orchestrator | write-worker | **New** bugs this session. Merged with existing ones |

---

## Progress Tracker Section Schema

Written by `developer-track-progress-write-worker` into the ticket `.md` file. Appended at the end if absent; replaces the existing block (from its preceding `---` separator) if present — matching either the current `# Progress Tracker` heading or the legacy `# Session Adjustment` heading. There is always exactly one such section.

```markdown
---

# Progress Tracker — <YYYY-MM-DD>

## Acceptance Criteria

- [x] <completed criterion>
- [ ] <incomplete criterion>

## Work Items

### Phase 1 — <phase label>

- [x] <completed task>
- [ ] <in-progress or unstarted task>

### Phase 2 — <phase label>

- [ ] <task from a later session>

## Progress

<narrative summary of what was implemented this session>

## Decisions

- <decision and rationale>

## Open Questions

- [ ] <unresolved question or blocker>

## Bugs

- [ ] <bug found this session>

## Status

<current development status>
```

### Progress Tracker Section Contracts

| Section | Required | Omit when | Written by | Purpose |
|---|---|---|---|---|
| `## Acceptance Criteria` | always | — | write-worker | Full AC checklist; checked items reflect confirmed done work |
| `## Work Items` | always | — | write-worker | Granular task checklist, **grouped into `### Phase N` subsections** — see Phase Rules |
| `## Progress` | always | — | write-worker | Narrative of what was implemented |
| `## Decisions` | conditional | `DECISIONS` is "none" | write-worker | Prose bullets — one per decision with rationale |
| `## Open Questions` | conditional | `OPEN_QUESTIONS` is "none" | write-worker | Checklist of unresolved questions or blockers |
| `## Bugs` | conditional | `BUGS` is "none" **and** none exist already | write-worker | Checklist of bugs; merged across sessions |
| `## Status` | always | — | write-worker | Current development status |

---

## Phase Rules

Work items are grouped into phases so that follow-up work on an already-tracked ticket appends rather than overwrites. A flat checklist cannot express "this was the original scope, this came later" — phases can.

**Numbering**

1. **Always start at Phase 1.** A ticket with no tracker gets `### Phase 1`. Never `Phase 0`, and never start at a higher number because the work feels like a continuation of something else.
2. **Numbers are assigned by the write-worker, recomputed from the file on every write** — read the existing `### Phase N` headings, take the highest `N`, and the next phase is `N + 1`. Never cache a number across invocations and never take one from the context block; `PHASE_NAME` carries the label only.
3. **Never renumber or reorder an existing phase.** Phase numbers are stable identifiers — someone may have referenced "Phase 2" in a review comment or a Jira thread.
4. **Never delete a phase**, even when every item in it is complete. The history is the point.

**Which phase this session's work goes into**

| `PHASE_MODE` | Behavior |
|---|---|
| `new` | Append `### Phase <highest + 1> — <PHASE_NAME>` with this session's items. Use when the session is follow-up work, a new scope, or a re-groom that surfaced work beyond the original. |
| `continue` | Add this session's items to the **highest-numbered** existing phase, and update its checkboxes. Use when the session simply advances work already scoped in that phase. |

If no tracker exists, `PHASE_MODE` is ignored — the result is always `### Phase 1`, labelled from `PHASE_NAME` when supplied and `Initial scope` otherwise.

**Merge semantics — every section accumulates**

A rewrite is a merge, never a replacement. Prior sessions' content survives:

| Section | On rewrite |
|---|---|
| `## Work Items` | Existing phases kept verbatim; items named in `COMPLETED_WORK_ITEMS` flip to `- [x]`. New items land per `PHASE_MODE` |
| `## Decisions` | Existing bullets kept; `DECISIONS` appended. A decision is only ever superseded by an explicit new bullet saying so — never silently dropped |
| `## Open Questions` | Existing kept; items named in `RESOLVED_QUESTIONS` flip to `- [x]` **in place** rather than being deleted; `OPEN_QUESTIONS` appended as new `- [ ]` |
| `## Bugs` | Existing kept; `BUGS` appended. Fixed bugs are checked, not removed |
| `## Acceptance Criteria` | Rebuilt from `ACCEPTANCE_CRITERIA` each time (the ticket's AC is the source of truth), with `COMPLETED_ITEMS` checked |
| `## Progress` | Replaced with this session's narrative — the only section that does not accumulate, since the phase list already carries the history |
| `## Status` | Replaced |

The practical consequence: re-running `/developer-track-progress` or re-grooming an already-groomed ticket is **safe and additive**. Nothing a previous session recorded is lost.
