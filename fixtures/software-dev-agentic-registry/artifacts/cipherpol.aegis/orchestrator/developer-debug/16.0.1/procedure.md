# Procedure — Debug

> **This file is not a skill.** It has no frontmatter and therefore no invocation
> gate, so any caller can execute it by loading it regardless of its own
> `disable-model-invocation` setting.
>
> Executed by:
> - `/developer-debug` — standalone entry point
> - `/developer-plan-feature` — Step 1.1 bug check
> - `/developer-groom-ticket` — "Start debugging" branch
>
> Callers must pass the **Inputs** below. Nothing here is auto-substituted —
> `$ARGUMENTS` is not expanded in a file that is loaded rather than invoked.

## Inputs

| Input | Required | Meaning |
|---|---|---|
| `bug_description` | no | Bug description supplied by the caller. May be empty. |
| `ticket_path` | no | Absolute path to a local ticket `.md` file, when the caller already resolved one. Skips the ticket lookup in Step 6. |

## Output

On wrap-up, surface `root_cause`, `fix_recommendation`, the investigation file path, and whether the ticket was updated.

**This procedure owns the whole debugging job.** A caller routes into it and stops — it does not resume its own workflow with these findings. `/developer-groom-ticket` hands off entirely rather than folding the result back into grooming; `/developer-plan-feature` tells the user to re-enter planning afterward. Anything the session should record durably goes to the investigation file and, on request, to the ticket — not back up the call chain.

## Orchestrator Contract

Only permitted direct operations:
- `Bash` — resolving paths, reading reference formats, `date`, and appending rounds to the investigation file
- `AskUserQuestion` — the intake questions and the session gate defined below

Never read source files, search the codebase, add or remove logs, or edit the ticket. Investigation is delegated to `developer-debug-strategist`, instrumentation to `developer-debug-log-worker`, and the ticket write to the `developer-track-progress-*` workers.

**You own the investigation file.** The strategist has no `Write` tool and never will — it is a pure-reasoning agent that returns Decision blocks. Each round's findings reach disk because you append them from the block it returned. If you skip that append, the round is lost: the strategist reads this file to build on prior rounds, and a gap makes it re-derive what was already established.

## Step 1 — Intake

If `bug_description` is non-empty, treat it as the initial bug description.

Collect any intake fields not covered by the description or visible context (e.g. an open ticket). Ask only for what is missing — one question at a time:

- Error message or stack trace (if not described)
- Expected vs actual behavior (if not described)
- Entry point — the action, method, or screen where the failure occurs (if not described)
- Platform: `web`, `ios`, or `flutter` (if not described)
- Target files or class names (if not already named in the description or ticket — skip this question if they are)
- Available logs (paste any relevant log output, or "none" if unavailable)

Do **not** ask for a ticket path here. Step 6 asks for it only if the user chooses to record findings, so a throwaway investigation never has to answer for one.

## Step 2 — First Investigation Round

Read the investigation document format, then create the file:

```bash
cat "$CLAUDE_PLUGIN_ROOT/reference/developer/debug-investigation-format.md"
```

Resolve `investigation_file` to `<project root>/.claude/agentic-state/developer/debug/<timestamp>-<slug>.md` — timestamp `YYYYMMDD-HHmmss`, slug kebab-case from the bug description, max 5 words. Create it with the header block that format defines.

Spawn `developer-debug-strategist` with all collected intake in the spawn prompt:

> Bug description: <description>
> Error message: <error>
> Expected: <expected> / Actual: <actual>
> Entry point: <entry-point>
> Platform: <platform>
> Target files: <comma-separated file paths or class names, or "unknown" if not identified>
> Available logs: <pasted log output, or "none">
> Investigation file: <investigation_file>
> Round: 1

It returns a `## Decision: investigate` block — schema in its agent body. Initialize three session-local values and carry them through every round:

- `logs_added` — `false` until a `mode: add` instrumentation run succeeds. Step 5 needs it.
- `round` — `1`.
- `instrumented_files` — empty. Every file a `mode: add` run touched, so Step 5 can name them if the user keeps the logs.

## Step 3 — Session Loop

The session ends when **the user** says so, not when the strategist first produces a root cause. A found root cause is a milestone in this loop, not its exit condition — the user may still want to instrument further, reproduce once more, or correct a wrong conclusion.

Repeat until the user selects **Wrap up**.

**3a — Persist the round.** Append the returned `Decision: investigate` block to `investigation_file` as a `## Round <round>` section, per `debug-investigation-format.md`. Do this **before** surfacing anything — the strategist reads this file next round, and an un-appended round is a round it will redo.

Never overwrite a prior round. The exception is a `user correction`: the strategist revises rather than repeats, so its revised block replaces the round it corrects, with the correction recorded in that round's `ruled_out`.

**3b — Surface the round.** Show `hypothesis`, `evidence`, `ruled_out`, and `conclusion` — the reasoning, not only the verdict. A user cannot redirect what they cannot see. When `state` is `root-cause-confirmed`, show `root_cause` and `fix_recommendation` too.

**3c — Ask what happens next.** Call `AskUserQuestion`. Build the option list from the block rather than offering all five every round:

```
question    : "Round <round> — <state: "root cause confirmed" | "narrowing down" | "no conclusion yet">

               <digest of conclusion, 2-4 lines>

               What next?"
header      : "Debug"
multiSelect : false
options     :
  - label: "Add debug logs",     description: "<summarize instrumentation_brief.points — which files get instrumented and what each tests>"
  - label: "Paste new logs",     description: "I reproduced it — here is the log output"
  - label: "Revise findings",    description: "The conclusion is wrong or incomplete — I'll correct it"
  - label: "Keep investigating", description: "Carry on from here with no new input from me"
  - label: "Wrap up",            description: "Done investigating — clean up and record the findings"
```

Two options are conditional on the block:

| Option | Include when |
|---|---|
| **Add debug logs** | `instrumentation_brief` is present. Omit it otherwise — offering instrumentation the strategist did not ask for invites guessing at locations. |
| **Paste new logs** | `needs_repro: true`, or instrumentation was added earlier in the session. |

Never synthesize an instrumentation brief yourself to keep the option available.

Route on the selection:

**Add debug logs** → spawn `developer-debug-log-worker`:

> MODE: add
> PLATFORM: <instrumentation_brief.platform>
> INSTRUMENTATION_BRIEF: <the block's `points` list verbatim — file, symbol, log, tests per entry>

Pass the brief verbatim; do not rewrite, extend, or reorder it. On success set `logs_added = true`, add the touched files to `instrumented_files`, then ask the user to reproduce the bug and paste the output. Treat what they paste as `new logs` and continue to 3e.

If the worker reports a location it could not find, surface that verbatim and return to 3c — never guess an alternative location on its behalf.

**Paste new logs** → collect the log output, then continue to 3e.

**Revise findings** → collect the user's correction verbatim, then continue to 3e with it as `user correction`.

**Keep investigating** → continue to 3e with no new input.

**Wrap up** → exit the loop and proceed to Step 4.

**3e — Next round.** Increment `round` and re-spawn `developer-debug-strategist` with the original intake plus:

> Investigation file: <investigation_file> — read it first; build on prior rounds, do not restart
> Round: <round>
>
> <if new logs were collected:>
> **New logs:**
> <the pasted output verbatim>
>
> <if a correction was given:>
> **User correction — the prior conclusion is wrong or incomplete:**
> <the correction verbatim>

Do **not** relay prior rounds inline. The investigation file is the handoff, and the strategist reads it — pasting rounds into the prompt duplicates them and grows every spawn.

Return to 3a.

There is no round cap. Every round is gated by the user, so the loop cannot run away — and a cap would end a session the user had not finished.

**If the strategist returns `Decision: blocked`** in any round, it cannot proceed without a user choice. Present its `question` and `options` via `AskUserQuestion`, then re-spawn the same round with the answer appended. Do not answer on its behalf and do not treat a `blocked` block as a finding.

## Step 4 — Summarize and Confirm

**4a — Distil the session.** Re-spawn `developer-debug-strategist` one final time:

> Mode: summarize
> Investigation file: <investigation_file>
> Round: <round>
> <the original intake>

It returns `## Decision: summarize` — `confidence`, `root_cause`, `evidence`, `ruled_out`, `fix_recommendation` (layer / file / change per entry), `open_questions`, `decisions`. Write it to `investigation_file` as its `## Root Cause` and `## Fix Recommendation` sections per the format doc.

**Replace those two sections if they already exist** — a session the user resumed via "No — keep going" reaches this step more than once, and the format allows exactly one of each. The `## Round <N>` sections above them always accumulate; only these two are rewritten.

This is the only invocation that may return `summarize`, and it happens only because the user chose Wrap up. The strategist never ends the session on its own.

**4b — Confirm.** Surface the summary:

```
question    : "<root_cause — or, when confidence is unconfirmed, "No root cause confirmed. Ruled out: <ruled_out>">

               Confidence: <confirmed | probable | unconfirmed>
               Fix: <one line per fix_recommendation entry — "<layer> — <file>: <change>">
               Investigation: <investigation_file>

               Is this the right conclusion to record?"
header      : "Confirm"
multiSelect : false
options     :
  - label: "Yes — record it",   description: "Proceed to cleanup and recording"
  - label: "No — keep going",   description: "Return to the session loop and refine"
```

**No — keep going** → return to Step **3c**, not 3a. The last round is already persisted and surfaced; re-entering at 3a would append it to the investigation file a second time.

**Yes** → proceed to Step 5.

A session with `confidence: unconfirmed` is a valid outcome. Carry it forward as-is — an honest "not found, here is what was ruled out" saves the next session from re-testing four hypotheses, and inventing a cause to fill the field is worse than leaving it empty.

## Step 5 — Remove Debug Logs

Skip if `logs_added` is `false` — nothing was instrumented.

Otherwise call `AskUserQuestion`:

```
question    : "Debug logs were added to source during this session. Strip them now?"
header      : "Cleanup"
multiSelect : false
options     :
  - label: "Yes — remove them",  description: "Recommended — instrumentation left in source ships to production"
  - label: "Keep them for now",  description: "I'm still reproducing; I'll remove them myself before committing"
```

**Yes** → spawn `developer-debug-log-worker`:

> MODE: remove
> PLATFORM: <platform>

**Keep them for now** → state plainly that instrumentation is still in the working tree and list `instrumented_files`, so it is not discovered in review.

## Step 6 — Record to Ticket

Call `AskUserQuestion`:

```
question    : "Write these findings to a ticket?"
header      : "Ticket"
multiSelect : false
options     :
  - label: "Yes",  description: "Add a Progress Tracker entry with the root cause and fix recommendation"
  - label: "No",   description: "Keep the investigation file only"
```

**No** → skip to Step 7.

**Yes** → if `ticket_path` is unset, ask for it and verify the file exists before continuing. If it does not exist, report the path and skip to Step 7 — never create a ticket file here.

**6a — Gather.** Spawn `developer-track-progress-gather-worker`:

> Read ticket at: `<ticket_path>`

Note `TICKET_PATH`, `TICKET_ID`, `ACCEPTANCE_CRITERIA` … `END_AC`, plus `TRACKER_STATE`, `HIGHEST_PHASE`, `EXISTING_PHASES`, and `OPEN_QUESTION_COUNT`.

If `TRACKER_STATE` is `legacy` or `current`, tell the user what will happen to the existing tracker before writing. The rules — including the legacy-heading upgrade and why the routing fields must not be forwarded — are owned by the format doc; read it rather than restating them:

```bash
cat "$CLAUDE_PLUGIN_ROOT/reference/developer/progress-tracker-format.md"
```

**6b — Assemble the context block.** Resolve today's date:

```bash
date +%F
```

Build the context block per that format doc's **Context Block Schema**, reading its **Phase Rules** section first. Every field maps from the `Decision: summarize` block confirmed in Step 4 — do not re-derive any of it from the session transcript:

| Field | From the `summarize` block |
|---|---|
| `BUGS` | `root_cause`, as one bullet. `none` when `confidence: unconfirmed`. |
| `PROGRESS` | A narrative from `evidence` and `ruled_out` — what was suspected, what the evidence showed, what was eliminated — then `fix_recommendation` as a list, one entry per line as `<layer> — <file>: <change>`. The write-worker derives this phase's work items from it. |
| `DECISIONS` | `decisions`, or `none`. Never restate a decision already in the tracker. |
| `OPEN_QUESTIONS` | `open_questions` not already listed on the ticket, or `none`. |
| `RESOLVED_QUESTIONS` | Prior open questions this session answered. Checked off in place, not deleted. `none` otherwise. |
| `STATUS` | `Ready for Planning` when `confidence` is `confirmed` or `probable`; `Blocked` when `unconfirmed`. Never `Ready for Review` — this procedure diagnoses, it never fixes. |
| `COMPLETED_ITEMS` | `none`, always. Diagnosing completes no acceptance criteria. |
| `COMPLETED_WORK_ITEMS` | Work items in earlier phases this session confirmed done, or `none`. |

**Keep the layer and file on every fix step.** They arrive that way — `fix_recommendation` entries carry `layer`, `file`, and `change` because the strategist traced the defect through the layers to find it. Preserve that shape:

```
- data — `.../repositories/attendance_repository_impl.dart`: guard the null `clockOutAt`
  before mapping and return a Failure instead of throwing
- pres — `.../attendance/attendance_bloc.dart`: surface that Failure as an error state
  rather than letting it escape the bloc
```

Flattening these to "fix the null handling" breaks the handoff: `/developer-build-feature` gives the ticket to a scoping agent that must assign each item a CLEAN layer (`domain`, `data`, `pres`, `app`, `ui`) and a concrete focus, and it would re-derive from scratch what this session already established.

**Choosing the phase:**

| Situation | `PHASE_MODE` | `PHASE_NAME` |
|---|---|---|
| No tracker yet (`TRACKER_STATE: none`) | `new` | short label for the defect, e.g. `Root cause — offline retry` |
| Fix work not already scoped in an existing phase | `new` | short label for the fix scope, becomes Phase `<HIGHEST_PHASE + 1>` |
| The session only confirmed the cause of work already scoped in the highest phase | `continue` | omit |

**A debug session that produces fix work not already on the ticket always opens the next phase.** Folding it into an existing phase destroys the record that this scope arrived after the original grooming.

**6c — Write.** Spawn `developer-track-progress-write-worker`:

- `ticket_path` — the resolved ticket path
- `context` — the full context block from 6b
- `date` — the date from 6b

Report the worker's confirmation to the user.

## Step 7 — End

This procedure diagnoses; it never applies a fix. The enriched ticket is the deliverable, and implementing from it is a separate, user-initiated run.

Report:

- `root_cause` and `fix_recommendation`, or that no cause was confirmed
- the investigation file path — the durable record of the session
- whether the ticket was updated, and which ticket
- whether debug logs are still in the working tree

If the ticket was updated, name the handoff explicitly — the enriched ticket is what the next command consumes:

> `<TICKET_ID>` updated at `<ticket_path>`. To implement the fix:
> - `/developer-plan-build-feature <ticket_path>` — plan then build in one run
> - `/developer-plan-feature <ticket_path>` — plan only, approve, build later
> - `/developer-build-feature <ticket_path>` — build straight from the recorded work items, no planning round

If the user declined the ticket write, point at the investigation file instead and note that those three entry points accept it as a document too — it is simply a weaker input, since it carries rounds of ruled-out hypotheses alongside the conclusion.

No `state.json` is written by this procedure.
