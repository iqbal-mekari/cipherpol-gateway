# QA Human-in-the-Loop Gates

> Related: gherkin-standard.md, pokayoke-integration.md, qa-testcase-worker.md, qa-automation-worker.md, hermetic-mock-standard.md, qa-mock-worker.md

Defines the mandatory human-approval checkpoints in the QA pipeline, and the rules every QA agent/skill must follow around them. The canonical test-case path is `testcases/`, and the sole visual/diagnostic tool for reviewing UI or Patrol state anywhere in this pipeline is `mcp__patrol__native-tree` — screenshots are never used for review or debugging.

## The 4-Phase Pipeline <!-- 37 -->

```
Phase 1: Test-Case Generation
  qa-generate-testcase -> qa-testcase-worker
  Output: testcases/<feature>/<feature>_test_cases.csv + markdown notes
        |
        v
   +-------------+
   |   GATE 1    |  Test Case Approval
   +-------------+
        | (approve only)
        v
Phase 2: Automation Triage & Mapping
  qa-generate-automation -> qa-automation-worker (triage stage)
  Output: mapping table (Test Case | Priority | Automate? | Screen Folder | Testcase File | Notes)
        |
        v
   +-------------+
   |   GATE 2    |  Mapping Table Confirmation
   +-------------+
        | (confirm only)
        v
Phase 3: Patrol Test Generation
  qa-automation-worker -> qa-create-patrol-testcase / qa-compose-patrol-scenario
  Output: Dart files in integration_test/testcases/ and integration_test/scenarios/
        |
        v
Phase 4: Execution & Self-Healing Debug
  qa-debug-automation -> qa-debug-worker (on failure)
  Output: fixed Dart test files + updated failure-pattern knowledge
```

Sync to pokayoke (`qa-sync-testcase` → `qa-sync-worker`) is a separate, independently-triggered workflow — it consumes Phase 1's CSV output but is not one of Gate 1/2 above. It has its own confirmation points instead (dry-run before apply, per-id confirmation before delete); see `pokayoke-integration.md`.

Mock backend generation (`qa-generate-mock` → `qa-mock-worker`) is likewise a separate, independently-triggered workflow — it is not a phase of the 4-phase pipeline above. It has its own gate, **Gate M**, before any file is written into the downstream repo; see below. Its output feeds Phase 3 (`qa-automation-worker` arranges via `MockControl`); see `hermetic-mock-standard.md` and `patrol-standard.md`.

## Gate 1 — Test Case Approval <!-- 14 -->

**When:** immediately after `qa-testcase-worker` produces or regenerates the CSV and markdown notes (Phase 1).

**What is reviewed:** the CSV at its written path — completeness against acceptance criteria, correctness of steps against actual app behavior, smoke/regression tagging, and scope (no out-of-scope API/backend cases slipped in).

**Prompt to the user** must include the CSV path, summary counts by priority and category, and a CSV preview — never a bare "approve?":

> Please review the test cases in `<csv_path>`. Summary: `<N total, N smoke, N regression, priority breakdown>`. Shall I proceed to automation triage, or would you like changes?

**Allowed responses:** approve (proceed to Phase 2) · request edits (stay in Phase 1) · cancel.

**On edit requests:** regenerate the affected cases and re-present at Gate 1 — never fall through to Phase 2 on anything short of explicit approval.

## Gate 2 — Mapping Table Confirmation <!-- 17 -->

**When:** immediately after the triage stage of `qa-automation-worker` produces the automation mapping table (Phase 2).

**What is reviewed:** which cases will be automated vs. skipped vs. need setup, screen-to-folder correctness, testcase file naming, and any "needs setup" items requiring env vars or fixture data.

**Prompt to the user** must show the full mapping table, not a summary count:

> Please confirm this mapping table. Should I proceed with writing the Patrol test files?
>
> | Test Case | Priority | Automate? | Screen Folder | Testcase File | Notes |
> |---|---|---|---|---|---|

**Allowed responses:** confirm (proceed to Phase 3) · request adjustments (stay in Phase 2) · cancel.

**On adjustment requests:** update the mapping entries and re-present at Gate 2 — no Dart is written before an explicit confirmation.

## Gate M — Mock Inventory Approval <!-- 22 -->

**When:** immediately after `qa-mock-worker` builds the endpoint/fixture inventory and the app-discovery table, before ANY file is written into the downstream repo.

**What is reviewed:** routes × taxonomy case × capture-vs-synthesize source × stateful branches, plus the discovered seams — env mechanism, base URL, port, session/storage keys.

**Prompt to the user** must carry the full inventory table AND the full discovery table — never a bare count:

> Please review the mock inventory below before any files are written to the repo.
>
> `<discovery table>`
>
> `<inventory table: route × taxonomy case × capture-vs-synthesize source × stateful branches>`
>
> Shall I proceed to scaffold/extend the mock backend, or would you like changes?

**Allowed responses:** proceed (write files) · request edits (stay at Gate M) · cancel.

**On edit requests:** revise the inventory/discovery tables and re-present at Gate M — never fall through to writing files on anything short of explicit approval.

**Note:** the three fixture-honesty gates (structural check, semantic parse through real response models, contract diff vs OpenAPI) run automatically after generation — they are automated checks, not human gates, and do not pause for approval.

## Who Asks — Gates Are Surfaced, Not Asked <!-- 12 -->

**An agent can never run a gate itself.** `AskUserQuestion` is stripped from a subagent's
tool set at spawn time regardless of what its `tools:` frontmatter declares — verified
empirically, see `docs/initiatives/orchestrator-composition-initiative.md`. An agent that
"calls AskUserQuestion" reaches nobody: the question lands in its own report, the
orchestrator reads it as text, and the pipeline advances without a human ever answering.
That is a silent gate bypass, which rule 1 forbids.

So a gate is always a **two-party protocol**. The agent prepares and returns; the calling
skill asks and re-invokes:

1. The agent stops at the gate and returns a `## Gate Pending` block instead of proceeding:

```
## Gate Pending
gate: <Gate 1 | Gate 2 | Gate M | delete-confirm | ...>
question: <the exact question to put to the user>
options: <label> | <label> | <label>
context:
<the full artifact — table, CSV preview, inventory — that rule 2 requires>
```

2. The calling **skill** (which runs in the main session and does have `AskUserQuestion`)
   surfaces `context` and `question` verbatim, collects the answer, and re-invokes the
   agent with the decision passed in as an input.
3. The agent resumes from the recorded decision.

Every gate below is subject to this. Where a gate section says "prompt to the user", it
describes what the skill must show — sourced from the agent's `context` field, never
paraphrased or summarised by the skill.

## Implementation Rules <!-- 9 -->

1. **Never skip a gate.** Gate 1, Gate 2, and Gate M are mandatory pause points for every skill/agent that reaches them, with no bypass flag.
2. **Give full context, never a bare "approve?".** Every gate prompt carries the artifact path/content, summary counts, and the specific decisions made so far — enough for an informed answer without opening another file.
3. **No silent progression.** A phase transition happens only on an explicit approval/confirmation ("proceed", "confirm", "yes", or equivalent) — never inferred from silence or an unrelated reply.
4. **Loop on edit requests.** Requested changes are applied and the same gate is re-presented — approval is never forced into a binary approve/reject; the human can iterate at a gate as many times as needed.
5. **Record every gate decision.** Write what was approved (and any modifications requested) to this run's state file at `.claude/agentic-state/runs/qa/<feature>/state.json` — the Run Directory convention used across CipherPol personas — so the decision is traceable after the fact, not just visible in the conversation.
6. **Never declare `AskUserQuestion` in an agent's `tools:`.** It is silently stripped, so declaring it documents a capability the agent does not have and hides a dead gate. Gates belong to skills; agents surface them per the section above.

## Non-Goals <!-- 3 -->

This document defines the gates only — it does not define the CSV schema (`gherkin-standard.md`), the Patrol authoring rules applied in Phase 3 (`patrol-standard.md`), or the pokayoke sync algorithm (`pokayoke-integration.md`). Consult those documents for the content each phase actually produces or consumes.
