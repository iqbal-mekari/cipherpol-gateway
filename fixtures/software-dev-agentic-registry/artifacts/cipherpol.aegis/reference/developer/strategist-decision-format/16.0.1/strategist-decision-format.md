# Strategist Decision Block Format

> Related: developer-feature-intent-strategist.md, developer-feature-convergence-strategist.md

Canonical schemas for all structured Decision blocks returned by feature strategist agents. Each agent emits only the subset relevant to its role — see per-agent notes below each block.

---

## Decision: spawn-planners

Returned when planners need to run (initial or follow-up round):

```
## Decision: spawn-planners
round: <N>
run_dir: <absolute path to run directory>
feature: <feature name>
platform: <web | ios | flutter>
module_path: <module path>
update_mode: <true | false>
restore_findings: <true | false>
spawn:
  - domain
  - data
  - pres
  - app
reason: <one line per planner explaining why it is needed>
findings_summary:          # convergence-strategist only — omit on first spawn-planners from intent-strategist
  domain: |
    - <key finding 1>
    - <key finding 2>
  data: |
    - <key finding 1>
  pres: |
    - <key finding 1>
  app: |
    - <key finding 1>
reasoning: |               # convergence-strategist only — why more rounds are needed, what gaps remain
  <explanation>
focus_notes:               # convergence-strategist only — present only after refine-spawn, omit otherwise
  domain: <user-directed focus for this layer>
  data: <user-directed focus for this layer>
  pres: <user-directed focus for this layer>
  app: <user-directed focus for this layer>
scope:
  domain: [entity, usecase, repository, service]   # omit types not relevant to this intent
  data:   [dto, mapper, datasource, repository_impl]
  pres:   [stateholder, screen, component, navigator]
  app:    [di, route, module, analytics, feature_flag]
open_questions:
  - <any unresolved requirement or ambiguity that a planner must answer>
pending_figma_urls:
  - <figma.com URL>   # intent-strategist only — empty list if no Figma found
completed_artifacts: [<list — omit if update_mode is false>]
figma_groups: <json — intent-strategist only, omit if not present>
```

Only list planners that are needed. Omit planners already explored in previous rounds unless new open questions require re-exploration. For each spawned planner, include only the scope types relevant to the stated intent.

**intent-strategist:** include `pending_figma_urls` and `figma_groups`.  
**convergence-strategist:** omit `pending_figma_urls` and `figma_groups`.

---

## Decision: resume-execution

Returned by `developer-feature-intent-strategist` only when checkpoint detection finds an existing plan and no re-planning is needed:

```
## Decision: resume-execution
run_dir: <absolute path to run directory>
plan_status: <pending | approved>
```

`plan_status: pending` → entry skill resumes at Step 4 (Approve).  
`plan_status: approved` → entry skill resumes at Step 5 (Execute — skips complete batches).

---

## Decision: discard-partial

Returned by `developer-feature-intent-strategist` only when the user wants to discard an interrupted planning run:

```
## Decision: discard-partial
run_dir: <absolute path to run directory>
```

---

## Decision: synthesized

Returned by `developer-feature-convergence-strategist` only when findings have converged and plan.md + context.md have been written:

```
## Decision: synthesized
summary:
  - <artifact 1> → <layer> / <status>
  - <artifact 2> → <layer> / <status>
  ...
```

The entry skill skips its synthesize step and proceeds directly to approval.

---

## Decision: blocked

Returned by either strategist when an unresolvable ambiguity or missing input requires user clarification:

```
## Decision: blocked
question: <specific question for the user>
options:
  - <option 1>
  - <option 2>
```

---

## Decision: ask-user

Returned by any strategist that needs a user selection mid-flow — run selection, resume intent, or any other choice it cannot make on the user's behalf.

**Strategists cannot ask.** `AskUserQuestion` is stripped from every subagent's tool set at spawn time, whatever the `tools:` frontmatter declares (verified — see `docs/initiatives/orchestrator-composition-initiative.md`). A strategist that "calls AskUserQuestion" asks nobody: the text lands in its own report and the flow advances on an answer the user never gave. Return this block instead.

```
## Decision: ask-user
step: <the strategist step to resume at, e.g. G1a, G1b, G2>
question: <the exact question to put to the user>
header: <short chip label, max 12 chars>
multi_select: true | false
options:
  - label: <short label>
    description: <what choosing this means>
context: |
  <optional — any table or summary the user needs in order to answer>
```

The entry skill presents it via `AskUserQuestion`, then re-spawns the strategist in the same mode with `resume_step: <step>` and `answer: <selected label(s)>` added to its inputs. A strategist receiving `resume_step` picks up at that step with the answer already decided and must not re-ask it.

Distinct from `blocked`: `ask-user` is a routine choice on the happy path, and the flow continues immediately after. `blocked` means the strategist cannot proceed at all without resolving an ambiguity.

---

## Decision: scope-options

Returned by `developer-feature-intent-strategist` in `pre-plan` mode when the user's goal is exploratory and the codebase structure suggests concrete scope candidates. The entry skill presents these options to the user, then re-spawns `gather-intent` with the confirmed scope as additional context.

```
## Decision: scope-options
problem_statement: |
  <1-3 sentences describing the apparent problem, opportunity, or area of concern found in the codebase>
options:
  - label: <short feature/scope name>
    description: <what this scope covers and which Clean Architecture layers are likely affected>
    module_path: <suggested module path>
```
