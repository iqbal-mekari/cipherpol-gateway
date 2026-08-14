---
name: developer-groom-ticket
description: Consult on a locally fetched Jira ticket — drives a back-and-forth discussion to clarify the problem statement, identify work items, surface decisions and open questions, then writes the grooming outcome to the ticket via the developer-track-progress workers. Run before /developer-plan-feature or /developer-plan-build-feature.
user-invocable: true
disable-model-invocation: true
allowed-tools: Agent, AskUserQuestion, Read, Bash
---

## Arguments

`$ARGUMENTS` — optional path to the local ticket `.md` file.

## Preflight — Resolve Thinker Model

```bash
echo "$CIPHERPOL_THINKER_MODEL"
```

If the value is `cost-saving`, the `Agent` spawn of `developer-groom-strategist` in Step 3 must pass `model: sonnet` as an override. Otherwise (unset, `optimized`, or any other value), omit the `model` parameter — the agent uses its frontmatter default (`opus`).

## Step 1 — Resolve Ticket Path

If `$ARGUMENTS` is provided, use it as the ticket path.

If `$ARGUMENTS` is empty, call `AskUserQuestion`:

```
question    : "What is the path to your local ticket file? (e.g. /path/to/TICKET-123.md)"
header      : "Ticket path"
multiSelect : false
options     :
  - label: "Enter path", description: "Provide the absolute path to the ticket .md file"
```

Verify the file exists before continuing. If it does not exist, report the path and stop.

## Step 2 — Bug Detection Gate

Read the ticket file. If the ticket type, title, or description indicates a bug (e.g. type is "Bug", title contains "fix", "broken", "error", "crash", description contains error messages or stack traces), surface a routing question via `AskUserQuestion`:

```
question    : "This ticket looks like a bug report. Would you like to start a debug investigation instead of grooming?"
header      : "Bug detected"
multiSelect : false
options     :
  - label: "Start debugging",    description: "Route to /developer-debug with this ticket's context"
  - label: "Continue grooming",  description: "Proceed with ticket consultation as normal"
```

**Start debugging** → hand the ticket off to the debug workflow and **stop**. Load its procedure — the shell expands `$CLAUDE_PLUGIN_ROOT`, so use Bash rather than `Read`:

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/developer-debug/procedure.md"
```

Follow it end to end with:

- `bug_description` — the bug description extracted from the ticket (title + description + error messages)
- `ticket_path` — the ticket path resolved in Step 1

Then stop. **Do not return to Step 3.** The debug procedure owns the whole job for a bug: it runs its own session loop until the user wraps up, and records the root cause and fix recommendation to this ticket itself. Re-entering the grooming consultation afterward would ask the same questions a second time and write the tracker twice. If the ticket still needs grooming once the cause is known, the user re-runs `/developer-groom-ticket` — Step 2b treats that as a normal re-groom and builds on what debug recorded.

**Continue grooming** → proceed to Step 3.

If the ticket does not look like a bug, skip this step entirely.

## Step 2b — Prior-Grooming Check

Grooming an already-groomed ticket is a normal, expected case — a scope changed, a follow-up landed, or the first pass left questions open. This run must **build on** that work, never restart or replace it.

Spawn `developer-track-progress-gather-worker`:

> Read ticket at: `<resolved ticket path>`

From its output note `TRACKER_STATE`, `HIGHEST_PHASE`, `EXISTING_PHASES`, and `OPEN_QUESTION_COUNT`. Hold all four — Step 3 and Step 4 both need them.

**If `TRACKER_STATE` is `legacy`**, the ticket carries a pre-2026-07-22 `# Session Adjustment` block. State plainly, without asking permission:

> `<TICKET_ID>` uses the legacy `Session Adjustment` heading. It will be renamed to `Progress Tracker` and its existing work items moved into `Phase 1 — Initial scope`, preserving text and checkbox state.

The rename is in place and lossless, and leaving both headings would give the ticket two trackers. The write-worker performs it in Step 4 — never edit the ticket here.

**If `TRACKER_STATE` is `current` or `legacy`**, this is a **re-groom**. Read the existing tracker block so Step 3 can pass it forward, and tell the user what is happening:

> `<TICKET_ID>` was groomed before — <HIGHEST_PHASE> phase(s), <OPEN_QUESTION_COUNT> open question(s). This run will build on that: prior decisions and work items are preserved, and anything new becomes the next phase.

**If `TRACKER_STATE` is `none`**, this is a first groom. Proceed normally.

## Step 3 — Consultation Loop

Spawn `developer-groom-strategist` with the ticket path and any prior grooming:

> **ticket-path:** <resolved absolute path>
>
> <if TRACKER_STATE is current or legacy:>
> **Prior grooming (re-groom — build on this, do not restart):**
> <the existing tracker block verbatim: its phases, decisions, open questions, bugs>
> Highest existing phase: <HIGHEST_PHASE>

Step 2 never reaches here with debug findings — the "Start debugging" branch is terminal. A ticket that was debugged first arrives as an ordinary re-groom, with the root cause already in the tracker block passed above.

The strategist reads the ticket and codebase, then returns a `Decision: discuss` block containing a `summary` (what it understands so far) and `questions` (what needs clarification).

Surface the strategist's output to the user via `AskUserQuestion`:

```
question    : "<strategist summary>

               Questions:
               <for each question: "• <question>">

               How would you like to proceed?"
header      : "Discussion"
multiSelect : false
options     :
  - label: "Answer above",  description: "Provide answers or clarifications"
  - label: "Wrap up",       description: "Problem statement and work items are clear — produce final summary"
```

**Answer above** → the user types clarifications. Re-spawn `developer-groom-strategist` with the original prompt **plus** all prior discussion context and the user's new answers appended. Do NOT use `SendMessage` — each round is a fresh agent spawn. Loop continues.

**Wrap up** → re-spawn `developer-groom-strategist` one final time with mode `summarize` and the full discussion history. The strategist returns a `Decision: summarize` block containing the grooming summary. Surface it to the user for confirmation:

```
question    : "<grooming summary>

               Does this capture the problem and work items correctly?"
header      : "Confirm"
multiSelect : false
options     :
  - label: "Looks good",       description: "Finalize and update the ticket"
  - label: "Needs adjustment", description: "Continue discussing — something is off"
```

**Looks good** → proceed to Step 4.

**Needs adjustment** → the user provides corrections. Return to the consultation loop — re-spawn the strategist in default mode with the full context plus corrections.

### Context Relay Between Rounds

Each re-spawn must include the **full discussion history** so the strategist has continuity:

```
ticket-path: <resolved absolute path>

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

## Step 4 — Update Ticket

Once the user confirms, write the grooming outcome to the ticket. `developer-track-progress` is a user-only skill (`disable-model-invocation: true`) and cannot be invoked programmatically, so this step drives its two workers directly — the same gather → write sequence that skill runs, with the session fields filled from the grooming summary instead of from an interactive question loop.

**4a — Reuse the gather output.** Step 2b already spawned `developer-track-progress-gather-worker`. Reuse that output — `TICKET_PATH`, `TICKET_ID`, `ACCEPTANCE_CRITERIA` … `END_AC`, plus the tracker-state fields. Do not spawn it a second time.

**4b — Assemble the context block.** Resolve today's date:

```bash
date +%F
```

Combine the gather output with the confirmed grooming summary into a full context block per `$CLAUDE_PLUGIN_ROOT/reference/developer/progress-tracker-format.md`. Read its **Phase Rules** section first. Map grooming → session fields:

- `PROGRESS` — narrate the grooming as this session's work: the Problem Statement, followed by the identified Work Items as a list (the write-worker derives this phase's items from it).
- `PHASE_MODE` / `PHASE_NAME` — see the table below.
- `DECISIONS` — decisions **new to this run**, or `none`. Never restate a decision already in the prior tracker; it is preserved automatically.
- `OPEN_QUESTIONS` — questions still unresolved after this run that are **not** already listed, or `none`.
- `RESOLVED_QUESTIONS` — prior open questions this run answered, or `none`. They get checked off in place rather than deleted.
- `STATUS` — `Ready for Planning`.
- `COMPLETED_ITEMS` — `none` (grooming completes no acceptance criteria).
- `COMPLETED_WORK_ITEMS` — work items in earlier phases this run confirmed done, or `none`.
- `BUGS` — defects the consultation surfaced that are **not** already in the tracker, or `none`. A root cause found by a debug session is not recorded here — that session wrote it to the ticket itself, and it is preserved automatically.

**Choosing the phase:**

| Situation | `PHASE_MODE` | `PHASE_NAME` |
|---|---|---|
| First groom (`TRACKER_STATE: none`) | `new` | `Initial scope` — becomes Phase 1 |
| Re-groom that surfaced **any** work item not already in an existing phase | `new` | short label for the new scope, e.g. `Offline retry` — becomes Phase `<HIGHEST_PHASE + 1>` |
| Re-groom that only clarified or corrected existing items, adding no new work | `continue` | omit |

**A re-groom that produces new work items always opens the next phase — never merge them into an existing one.** Phases are how the ticket records that this scope arrived later, and folding new work into Phase 1 destroys exactly that. `continue` is only for the narrow case where nothing new was identified.

Do not forward `TRACKER_STATE`, `HIGHEST_PHASE`, `EXISTING_PHASES`, or `OPEN_QUESTION_COUNT` in the context block — they are routing inputs for this skill only, and the write-worker re-reads the file itself.

**4c — Write the section.** Spawn `developer-track-progress-write-worker`:

- `ticket_path` — the resolved ticket path
- `context` — the full context block from 4b
- `date` — the date from 4b

Report the worker's confirmation to the user, then point to the next step:

> Ticket updated. Run `/developer-plan-feature` (or `/developer-plan-build-feature`) when ready to plan the implementation.

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
