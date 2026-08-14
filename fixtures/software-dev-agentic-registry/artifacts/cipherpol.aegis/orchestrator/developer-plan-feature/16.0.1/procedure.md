# Procedure — Plan Feature

> **This file is not a skill.** It has no frontmatter and therefore no invocation
> gate, so any caller can execute it by `Read`-ing it regardless of its own
> `disable-model-invocation` setting.
>
> Executed by:
> - `/developer-plan-feature` — standalone entry point
> - `/developer-plan-build-feature` — composite entry point (plan, then build)
>
> Callers must pass the **Inputs** below. Nothing here is auto-substituted —
> `$ARGUMENTS` is not expanded in a file that is `Read` rather than invoked.

## Inputs

| Input | Meaning |
|---|---|
| `arguments` | Only what the caller passed as formal arguments (Jira URL, PRD URL, Figma URL, local path, or empty) |
| `user_message` | The full user message verbatim — context, directory hints, instructions |

**`arguments` is not `user_message`.** Instructions and context in the message body are NOT processed here — pass them verbatim to the strategist in Step 1. Do not read files, grep, or explore based on anything in the message body.

## Routing Contract

This procedure is a pure router. Its only permitted direct operations:
- `Bash` — preflight existence checks and run-dir persistence writes only
- `Read` — only for explicit `.md` input files passed in `arguments`
- `WebFetch` — only for non-Figma URLs passed in `arguments`
- `AskUserQuestion` — approval prompts defined in each step

Never confirm, summarize, or add extra questions between steps. Route directly on the Decision block returned by the strategist.

Never read source files, search the codebase, or write code. All exploration, planning, and implementation is exclusively delegated to strategist / planner / worker agents.

## Preflight — Resolve Working Context

Run **before anything else**. Full protocol: `$CLAUDE_PLUGIN_ROOT/reference/aegis/working-context.md`.

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/aegis-resolve-context/resolve_context.py" \
  --taxonomy="$CLAUDE_PLUGIN_ROOT/reference/cipherpol.json" \
  --hint="<user_message verbatim>"
```

Add `--path=<p>` for each local path in `arguments`. Hold `project_root`,
`platform`, `project`, `cp1_slug`, and `state_dir` for the whole run.

On `source=ambiguous`, present the `candidate=` lines via `AskUserQuestion` (one
option each, `label` = project, `description` = `<platform> · <path>`) and re-run
with `--repo=<chosen>`. On an `error=` line with no candidates, tell the user to
run `/aegis-setup-cipherpol` and stop.

Then echo one line and continue — a statement, not a question:

```
▸ <project> · <platform> · <project_root>
```

## Preflight — Detect Existing Runs

```bash
find "<state_dir>/developer/feature-plans" -maxdepth 2 -name "plan.md" 2>/dev/null
find "<state_dir>/developer/feature-plans" -maxdepth 2 -name "figma-fetch-dir.txt" 2>/dev/null
```

Collect results as `found_plans` and `found_figma` (`figma-fetch-dir.txt` paths). **Do not route yet.** Pass them to Step 1 so the strategist sees the user's intent alongside any existing runs before making a routing decision.

## Preflight — Resolve Thinker Model

```bash
echo "$CIPHERPOL_THINKER_MODEL"
```

If the value is `cost-saving`, every `Agent` spawn of `developer-feature-intent-strategist`, `developer-feature-convergence-strategist`, or a layer planner (`developer-domain-planner`, `developer-data-planner`, `developer-pres-planner`, `developer-app-planner`) anywhere in this procedure must pass `model: sonnet` as an override. Otherwise (unset, `optimized`, or any other value), omit the `model` parameter — each agent uses its frontmatter default (`opus`). This does not apply to `developer-figma-fetch-worker`.

## Step 0 — Classify Inputs

Parse only `arguments`. This procedure only fetches things that require its network tools — local files and directories go to the strategist as raw paths.

| Pattern | Type | Action |
|---|---|---|
| URL containing `jira` or `atlassian`, or bare ticket ID (e.g. `PROJ-123`) | Jira ticket | Fetch inline via Atlassian MCP → `resolved_inputs` |
| Any other URL (excluding `figma.com`) | PRD / doc | Fetch inline via `WebFetch` → `resolved_inputs` |
| `figma.com` URL | Figma frame or section URL | Add to `pending_figma_urls` — passed to `developer-fetch-figma` in Step 1.2 |
| Local path where `ls <path>/state.json` or `ls <path>/plan.md` returns results | Existing run dir | Set as `explicit_run_dir` — skip Step 1, route via inline checkpoint below |
| Local path where `ls <path>/figma-groups.json` returns results | Existing figma fetch dir | Set as `figma_fetch_dir` — skip Step 1.2 |
| Local file path or directory path | Local content | Add to `raw_paths` — do not read |

If `arguments` is empty, skip this step — proceed to Step 1 with `resolved_inputs = []` and `raw_paths = []`.

### Explicit run_dir checkpoint routing

If `explicit_run_dir` was set above, inspect disk state and route without calling the strategist for gather-intent:

```bash
ls "<explicit_run_dir>/plan.md" 2>/dev/null
grep "^status:" "<explicit_run_dir>/plan.md" 2>/dev/null | head -1
python3 -c "
import json, sys
d = json.load(open('<explicit_run_dir>/state.json'))
layers = [k for k in ('domain','data','pres','app') if d.get(k)]
print('artifact_layers:', ','.join(layers))
" 2>/dev/null
cat "<explicit_run_dir>/figma-fetch-dir.txt" 2>/dev/null
```

Route:

| Disk state | Action |
|---|---|
| `plan.md` exists (any status) | Set `run_dir = explicit_run_dir`. Proceed to Step 1 — pass `run_dir` to the strategist so it skips the run-selection prompt and goes straight to gathering updated intent. |
| No `plan.md` + state.json has ≥ 1 populated artifact layer | Set `run_dir = explicit_run_dir`. Restore `visited` from all populated layer keys (`domain`, `data`, `pres`, `app`) in state.json. Proceed directly to Step 2b (call strategist `process-findings`). |
| No `plan.md` + no populated artifact layers | Set `run_dir = explicit_run_dir`. Proceed to Step 1 — pass `run_dir` to the strategist so G1 skips the run-selection prompt and goes straight to G1b. |

Collect:
- `resolved_inputs` — successfully fetched remote items: `{ type, source, content }`
- `raw_paths` — local file and directory paths to hand to the strategist
- `failed_inputs` — remote items that could not be fetched: `{ type, source, reason }`

If `failed_inputs` is non-empty, call `AskUserQuestion`:

```
question    : "Some inputs couldn't be fetched: <list each with reason>. What would you like to do?"
header      : "Input Fetch"
multiSelect : false
options     :
  - label: "Continue",         description: "Proceed with the inputs that were successfully resolved"
  - label: "Provide manually", description: "Paste or describe the missing content before continuing"
  - label: "Cancel",           description: "Stop and retry after fixing the inputs"
```

**Continue** → proceed with `resolved_inputs` as-is.
**Provide manually** → collect content from user, append to `resolved_inputs`. Then proceed.
**Cancel** → stop.

## Step 1 — Gather Intent

Skip if `explicit_run_dir` was set in Step 0 (route via checkpoint above).

Call `AskUserQuestion`:

```
question    : "Do you have a specific feature goal in mind?"
header      : "Goal Clarity"
multiSelect : false
options     :
  - label: "Yes — I know what to build",  description: "Proceed directly to intent gathering"
  - label: "Not yet — explore first",      description: "Browse the codebase to identify the right scope before planning"
```

**Not yet** → spawn `developer-feature-intent-strategist` in `pre-plan` mode:

> **Mode: pre-plan**
>
> **Working Context:** project_root=<project_root> · state_dir=<state_dir> · platform=<platform> · cp1_slug=<cp1_slug>
>
> **User message:**
> \<`user_message` verbatim\>
>
> \<if raw_paths is non-empty:\>
> **Raw Paths:**
> \<list each path\>

Route on `Decision: scope-options` — call `AskUserQuestion`:

```
question    : "<problem_statement from decision>

               Which of these scopes fits what you have in mind?"
header      : "Scope"
multiSelect : false
options     :
  <one option per entry in decision.options — label = label, description = description>
```

Store the selected option as `pre_plan_context` (label, description, module_path).

Spawn `developer-feature-intent-strategist` in `gather-intent` mode:

> **Mode: gather-intent**
>
> **Working Context:** project_root=<project_root> · state_dir=<state_dir> · platform=<platform> · cp1_slug=<cp1_slug>
>
> **User message:**
> \<`user_message` verbatim — includes any context, directory hints, or instructions the user provided\>
>
> <if found_plans or found_figma is non-empty, include:>
> **Existing runs:**
> \<found_plans list, or "(none)"\>
> **Existing figma groups:**
> \<found_figma list, or "(none)"\>
>
> <if resolved_inputs is non-empty, include:>
> **Resolved Inputs:**
> <for each item: "### <type> — <source>\n<content>">
>
> <if raw_paths is non-empty, include:>
> **Raw Paths:**
> \<list each path — strategist should read these to extract context and Figma URLs\>
>
> <if pre_plan_context is set, include:>
> **Pre-selected scope:**
> Feature: \<label\>
> Scope: \<description\>
> Module path: \<module_path\>
>
> Ask the user for feature intent. Surface any existing runs and let the user choose to continue or start fresh. Return a Decision block when done.

Wait for the strategist to return. Route based on the Decision block:

- **`Decision: ask-user`** → the strategist cannot ask anything itself (`AskUserQuestion` is stripped from every subagent), so **you** own every user choice in the intent flow. Present the block's `question`, `header`, `multi_select`, and `options` verbatim via `AskUserQuestion`, showing its `context:` field first if present. Then re-spawn the strategist in the same mode with all original inputs plus `resume_step: <step from the block>` and `answer: <the label(s) the user selected>`. Loop — a single intent flow can return `ask-user` several times (`G1a`, then `G1b`, then `G2`). Never answer on the user's behalf, and never collapse two `ask-user` rounds into one assumed answer.
- **`Decision: discard-partial`** → `rm -rf "<run_dir from decision>"`. Re-spawn strategist in `gather-intent` mode (same inputs, minus the discarded path from `found_plans`/`found_figma`).
- **`Decision: resume-execution`** (any `plan_status`) → extract `run_dir` and `open_questions` from the Decision block. Set `update_mode = true`. Read `raw_docs` from context.md:

  ```bash
  python3 -c "
  import re, sys
  try:
      import yaml
      with open('<run_dir>/context.md') as f:
          m = re.match(r'^---\n(.*?)\n---', f.read(), re.DOTALL)
      if m:
          d = yaml.safe_load(m.group(1))
          for r in d.get('raw_docs', []):
              print(r['path'] + ' — ' + r['description'])
  except: pass
  " 2>/dev/null
  ```

  Set `raw_docs` from the script's output (empty list if context.md absent). Restore `figma_fetch_dir` from `<run_dir>/figma-fetch-dir.txt` if present. Proceed to Step 1.1.

- **`Decision: spawn-planners`** → extract `feature`, `platform`, `module_path`, `run_dir`. If `update_mode: true` also extract `open_questions`. Initialize `visited = []`, `round = 1` — **ignore any `round:` value present in the Decision block itself.** Proceed to Step 1.1.

## Step 1.1 — Bug Check

Skip if `update_mode` is true (resuming an existing run).

Call `AskUserQuestion`:

```
question    : "Is this a bug that needs investigation before planning a fix?"
header      : "Bug Check"
multiSelect : false
options     :
  - label: "No — this is a feature",   description: "Proceed to planning"
  - label: "Yes — investigate first",  description: "Run /developer-debug to find root cause before planning (recommended)"
```

**No** → proceed to Step 1.2.

**Yes** → execute the debug workflow. Load its procedure — the shell expands `$CLAUDE_PLUGIN_ROOT`, so use Bash rather than `Read`:

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/developer-debug/procedure.md"
```

Follow it end to end with `bug_description` = the bug description from the gathered intent. Leave `ticket_path` unset — that procedure asks for one only if the user chooses to record findings.

The debug procedure owns the whole investigation: its own session loop until the user wraps up, log cleanup, and an optional ticket write. It reports its own findings at the end, so add only the re-entry pointer:

> "Return here with `/developer-plan-feature` to plan the fix."

Stop.

## Step 1.2 — Figma

Skip if `figma_fetch_dir` is already set (resolved from Step 0).

Call `AskUserQuestion`:

```
question    : "Do you want to include Figma designs in this feature plan?"
header      : "Figma"
multiSelect : false
options     :
  - label: "Yes",  description: "Fetch and group Figma frames before planning"
  - label: "No",   description: "Proceed with requirement docs only"
```

**No** → proceed to Step 2.

**Yes** → execute the Figma-fetch workflow. Load its procedure — the shell expands `$CLAUDE_PLUGIN_ROOT`, so use Bash rather than `Read`:

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/developer-fetch-figma/procedure.md"
```

Follow it end to end with `arguments` = any `pending_figma_urls` from Step 0. When it completes:
- Extract `figma_fetch_dir` from the `Fetch directory:` line in its output
- Write the pointer: `echo "$figma_fetch_dir" > "<run_dir>/figma-fetch-dir.txt"`
- Proceed to Step 2

## Step 2 — Planning Convergence Loop

**Reset session counters.** Always set `round = 1` and `visited = []` here, regardless of `update_mode` or what state.json contains from prior sessions. The convergence loop is session-local and has no relation to run history — any `round:` value returned by the strategist's Decision block must never be used to seed this counter.

Repeat until the strategist returns `Decision: converged` or `Decision: blocked`.

**Derive `raw_docs`** at the start of the first round (round = 1) — held as a session-local variable. Skip if `raw_docs` was already restored from context.md in the resume path above.

```bash
python3 - <<'EOF'
import os, re, json
raw_docs = []
for p in [<raw_paths as Python list, or []>]:
    desc = os.path.basename(p)
    try:
        with open(p) as f:
            for line in f:
                line = line.strip()
                if line:
                    desc = re.sub(r'^#+\s*', '', line)[:120]
                    break
    except:
        pass
    raw_docs.append({"path": p, "description": desc})
print(json.dumps(raw_docs))
EOF
```

Store the output as the session-local `raw_docs` list.

### 2a — Spawn planners for this round

From the current `Decision: spawn-planners` block, read the `spawn:` list. Spawn each listed planner **in parallel** (single Agent tool call with all planners in that round):

- `developer-domain-planner` — if `domain` is in the spawn list
- `developer-data-planner` — if `data` is in the spawn list
- `developer-pres-planner` — if `pres` is in the spawn list
- `developer-app-planner` — if `app` is in the spawn list

Pass to each planner: feature name, platform, module-path, run_dir, **`project_root`**, and **`cp1_slug`** — the last two come from the Working Context and let the planner scope its `Glob`/`Grep` to the right repo.

**If `raw_docs` is non-empty**, also pass:
- `raw_docs` — list of `{ path, description }` entries. Format: one entry per line as `<path> — <description>`.

**If `update_mode` is true**, also pass:
- `open_questions` — the user's stated issues from the Decision block, verbatim.

**For `developer-pres-planner`** — if `figma_fetch_dir` is set, also pass:
- `figma_fetch_dir` — planner reads `<figma_fetch_dir>/figma-groups.json` for screen and state structure.

Track `spawned_planners` as a session-local list. Wait for all planners in this round to complete. Proceed to 2b.

### 2b — Send findings to strategist

Spawn `developer-feature-convergence-strategist`:

> **Mode: process-findings**
>
> **Working Context:** project_root=<project_root> · state_dir=<state_dir> · platform=<platform> · cp1_slug=<cp1_slug>
>
> Round: <N>
> Visited layers: <comma-separated list from visited set>
> Spawned planners: <comma-separated list from spawned_planners>
> run_dir: <run_dir>
> update_mode: <true | false>
>
> <if update_mode is true, include:>
> **existing_plan:**
> \<content of the archived plan-vN.md — re-read from disk if not already in context\>
>
> **existing_context:**
> \<content of the archived context-vN.md — re-read from disk if not already in context\>
> \<end if\>
>
> findings_dir: <run_dir>/findings/

Wait for the strategist's decision block.

- **`Decision: synthesized`** → plan.md and context.md are already written; skip Step 3 and proceed directly to Step 4
- **`Decision: blocked`** → present the strategist's question to the user via `AskUserQuestion`, send the answer back to strategist as a follow-up `process-findings` call, then re-evaluate
- **`Decision: spawn-planners`** → do NOT act on it immediately. Proceed to the **Convergence Gate** below.

**Max rounds guard:** If `round` reaches 6 without convergence, stop the loop and surface to the user:
> "Planning could not converge after 5 rounds. Open questions: <list from last blocked decision>. Please clarify before retrying."

### Convergence Gate

After receiving `Decision: spawn-planners` from the strategist, extract `findings_summary`, `reasoning`, and `spawn`. Build the findings display:

```
<for each layer present in findings_summary:>
<Layer>:
<bullet points from findings_summary[layer]>
```

Call `AskUserQuestion`:

```
question: "Round <N> complete.

           Findings:
           <findings display>

           Strategist reasoning: <reasoning>
           Proposed next round: <spawn list>"
header: "Convergence"
multiSelect: false
options:
  - label: "Confirm",       description: "Run next round as proposed"
  - label: "Discuss",       description: "Redirect or ask something before the next round runs"
  - label: "Converge now",  description: "Synthesize a plan with what we have"
```

**Confirm** → increment `round`, carry `focus_notes` (empty) forward, go back to 2a.

**Converge now** → proceed directly to Step 3 (synthesize).

**Discuss** → collect the user's free text. Spawn `developer-feature-convergence-strategist` in `refine-spawn` mode:

> **Mode: refine-spawn**
>
> **Working Context:** project_root=<project_root> · state_dir=<state_dir> · platform=<platform> · cp1_slug=<cp1_slug>
>
> run_dir: <run_dir>
> user_direction: <user's free text verbatim>
> previous_findings_summary: <findings_summary block from last Decision>
> previous_reasoning: <reasoning block from last Decision>
> previous_spawn: <spawn list from last Decision>

Wait for the revised `Decision: spawn-planners`. Extract the updated `spawn`, `reasoning`, and `focus_notes`.

Present the revision to the user:

```
question: "Updated proposal based on your input.

           Strategist reasoning: <updated reasoning>
           Revised next round: <updated spawn list>
           <if focus_notes non-empty:>
           Focus notes: <per-layer focus_notes>"
header: "Convergence"
multiSelect: false
options:
  - label: "Confirm",       description: "Run the revised round"
  - label: "Converge now",  description: "Synthesize a plan with what we have"
```

**Confirm** → increment `round`, carry `focus_notes` forward to 2a.
**Converge now** → proceed directly to Step 3 (synthesize).

**Passing `focus_notes` to planners:** In Step 2a, if `focus_notes` is non-empty, append to each matching planner's input:

> focus: <focus_notes[layer]>

## Step 3 — Synthesize Plan (fallback only)

> **When reached:** Only reached if `Decision: synthesized` has not yet been returned — e.g., a `discuss-more` re-synthesis triggered from Step 4. The normal convergence path skips here because `Decision: synthesized` from Step 2b means plan.md and context.md are already on disk.

Spawn `developer-feature-convergence-strategist` with mode `synthesize`:

> **Mode: synthesize**
>
> **Working Context:** project_root=<project_root> · state_dir=<state_dir> · platform=<platform> · cp1_slug=<cp1_slug>
>
> raw_docs:
> \<list each as "\<path\> — \<description\>", or "(none)"\>
>
> \<if update_mode is true:\>
> **update: true**
>
> **existing_plan:**
> \<content of current plan.md — read from disk\>
>
> **existing_context:**
> \<content of current context.md — read from disk\>
> \<end if\>
>
> findings_dir: <run_dir>/findings/

Wait for the strategist to return the plan summary and write plan.md + context.md.

## Step 4 — Approve

Call `AskUserQuestion` immediately after synthesis — do NOT describe choices in prose:

```
question    : "What would you like to do with this plan?"
header      : "Plan"
multiSelect : false
options     :
  - label: "Approve",      description: "Mark plan as approved and hand off for execution"
  - label: "Discuss more", description: "I have questions or changes before this plan is finalized"
  - label: "Discard",      description: "Cancel and delete this plan"
```

**Approve** → Update `plan.md` frontmatter: set `status: approved` and add `context_doc: context.md`. Output:

```
## Plan Output
run_dir: <run_dir>
status: approved
context_doc: context.md
```

Stop.

**Discuss more** → address the engineer's questions inline. If the plan itself needs revision, re-run Step 3 (re-synthesize) with the updated requirements added to the findings context. Then call `AskUserQuestion` again with the same three options.

**Discard** → delete the most recent run directory:

```bash
rm -rf "<state_dir>/developer/feature-plans/<feature>"
```

Stop.
