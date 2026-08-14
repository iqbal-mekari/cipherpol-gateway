---
name: developer-track-progress
description: Track session progress on one or more locally fetched Jira ticket files. Gathers context per ticket then writes the Progress Tracker section for each.
user-invocable: true
disable-model-invocation: true
allowed-tools: Agent, AskUserQuestion
---

## Arguments

`$ARGUMENTS` — optional. One or more absolute paths to local ticket `.md` files, space-separated.

## Steps

### Step 1 — Collect Ticket Paths

If `$ARGUMENTS` is provided, parse paths from it.

Otherwise, ask:
> "How many tickets did you work on this session?"

Then for each ticket (1..N), ask:
> "Path to ticket <N>? (e.g. /path/to/TICKET-123.md)"

Verify each path exists before continuing. Report any missing paths and stop.

### Step 2 — Gather and Collect Context (per ticket, sequential)

For each ticket, complete all three sub-steps before moving to the next ticket.

**2a. Read ticket** — spawn `developer-track-progress-gather-worker`:

> Read ticket at: `<ticket_path>`

Collect the partial context block (TICKET_PATH, TICKET_ID, ACCEPTANCE_CRITERIA…END_AC) plus its tracker-state fields: `TRACKER_STATE`, `HIGHEST_PHASE`, `EXISTING_PHASES`, `OPEN_QUESTION_COUNT`.

**Legacy heading.** If `TRACKER_STATE` is `legacy`, this ticket carries a pre-2026-07-22 `# Session Adjustment` block. Tell the user plainly before continuing:

> `<TICKET_ID>` uses the legacy `Session Adjustment` heading. It will be renamed to `Progress Tracker` and its existing work items moved into `Phase 1 — Initial scope`, preserving text and checkbox state.

Do not ask permission — the upgrade is in place and lossless, and leaving both headings would give the ticket two trackers. Just say it is happening. The write-worker performs the rename; never edit the ticket here.

**2b-0. Decide the phase.** If `TRACKER_STATE` is `none`, this is `PHASE_MODE: new` with `PHASE_NAME: Initial scope` — Phase 1. Otherwise show `EXISTING_PHASES` and ask via `AskUserQuestion`:

```
question    : "[<TICKET_ID>] This ticket already has <HIGHEST_PHASE> phase(s). Where does this session's work belong?"
header      : "[<TICKET_ID>] Phase"
multiSelect : false
options     :
  - label: "Continue Phase <HIGHEST_PHASE>", description: "<label of that phase> — this session advances work already scoped there"
  - label: "New phase",                      description: "Follow-up work beyond that phase — starts Phase <HIGHEST_PHASE + 1>"
```

**New phase** → ask for a short `PHASE_NAME` (e.g. `Error handling`). This question does not count against the 10-question cap in 2b.

**2b. Dynamic question loop** — gather session context using `AskUserQuestion`. Prefix every question header with `[<TICKET_ID>]`. Hard cap: **10 questions total**.

**Anchor questions** — always ask these first, in order:

1. `What progress was made this session?`
   Options: `"Partially implemented"`, `"Mostly implemented"`, `"Fully implemented"` — user may detail via Other.

2. `What is the current development status?`
   Options: `"In Progress"`, `"Ready for Review"`, `"Blocked"`, `"Done"`

3. `Which Acceptance Criteria were completed this session?`
   Description: list every AC item from step 2a so the user can reference them.
   Options: `"None"`, `"All"`, `"Some — list them (use Other)"`

4. `Which work items from earlier phases were finished this session?` — **ask only when `HIGHEST_PHASE` ≥ 1.** Description: list `EXISTING_PHASES` so the user can reference them.
   Options: `"None"`, `"Some — list them (use Other)"`. Fills `COMPLETED_WORK_ITEMS`.

5. `Were any previously open questions answered this session?` — **ask only when `OPEN_QUESTION_COUNT` > 0.**
   Options: `"None"`, `"Some — list them (use Other)"`. Fills `RESOLVED_QUESTIONS`.

Questions 4 and 5 exist because the tracker merges rather than overwrites — without them, earlier phases and stale open questions would stay unchecked forever.

**Follow-up loop** — after each answer (including anchor answers), evaluate the current context against all required fields (`PROGRESS`, `STATUS`, `COMPLETED_ITEMS`, `COMPLETED_WORK_ITEMS`, `RESOLVED_QUESTIONS`, `DECISIONS`, `OPEN_QUESTIONS`, `BUGS`). Ask one targeted follow-up if:

- A field is still unfilled **and** the session context makes it plausible (e.g. if progress mentions issues → ask about bugs; if status is `Blocked` → ask about open questions; if progress mentions tradeoffs → ask about decisions).
- An answer is too vague to fill its field reliably (e.g. "some things" as a progress answer → ask which components specifically).

**Do not** ask about a field if prior answers already imply its value (e.g. smooth progress with no issues mentioned → `BUGS: none`, no follow-up needed). Default unfilled optional fields to `"none"` if no follow-up is warranted.

**Terminate** when all required fields can be filled with reasonable confidence, or when the question count reaches 10 — whichever comes first.

**2c. Assemble context block** — combine the partial context from 2a with the answers from 2b into a full context block per the schema in `$CLAUDE_PLUGIN_ROOT/reference/developer/progress-tracker-format.md`, including `PHASE_MODE` / `PHASE_NAME` from 2b-0 and `COMPLETED_WORK_ITEMS` / `RESOLVED_QUESTIONS` from the anchor questions. Default any unasked field to `none`.

Do **not** forward `TRACKER_STATE`, `HIGHEST_PHASE`, `EXISTING_PHASES`, or `OPEN_QUESTION_COUNT` — those are yours for routing only. The write-worker re-reads the file itself and must not act on a snapshot taken before this session's questions.

### Step 3 — Write Sections (per ticket)

For each ticket, spawn `developer-track-progress-write-worker` with:

- `ticket_path` — the ticket file path
- `context` — the full context block assembled in Step 2c
- `date` — today's date in ISO 8601

### Step 4 — Done

Report:
> "Done — Progress Tracker updated for <N> ticket(s): <list of ticket IDs>"

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
