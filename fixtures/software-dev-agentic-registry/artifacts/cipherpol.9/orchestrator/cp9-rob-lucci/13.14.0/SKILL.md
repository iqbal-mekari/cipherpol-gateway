---
name: cp9-rob-lucci
description: Discover then plan then build — cp9-jabra-discovery explores freely until you're ready to plan, cp9-fukurou-planner writes plan.md, cp9-kaku-worker builds. Discovery loops until you say go.
user-invocable: true
disable-model-invocation: true
allowed-tools: Agent, AskUserQuestion, Bash, Read
---

## Routing Contract

This skill is a pure router. Its only permitted direct operations:
- `Bash` — preflight existence checks, run-dir creation, slug generation
- `Read` — only `discovery.md` or `plan.md` from a run directory
- `AskUserQuestion` — discovery loop gate and approval gate
- `Agent` — spawning `cp9-jabra-discovery`, `cp9-fukurou-planner`, and `cp9-kaku-worker`

**All agents are always spawned via the `Agent` tool. Never use the `Skill` tool for them.**

Never explore files, read source, or write code directly — all of that is delegated to the agents.

## Arguments

`$ARGUMENTS` — optional. Accepts:
- A plain description: `"something feels off with the auth flow"`
- A spec file path (`.md`): `docs/specs/2026-06-18-feature-design.md`
- Both: `docs/specs/2026-06-18-feature-design.md investigate the payment module`

If a `.md` file path is present in `$ARGUMENTS`, extract it as `spec_path` and verify it exists:

```bash
spec_path=$(echo "$ARGUMENTS" | grep -oE '[^ ]+\.md' | head -1)
[ -n "$spec_path" ] && ls "$spec_path" 2>/dev/null || spec_path=""
```

Pass `spec_path` to `cp9-jabra-discovery` in Step 1 — it will read it before exploring.

## Preflight — Detect Existing Runs

```bash
find "$(git rev-parse --show-toplevel)/.claude/agentic-state/runs/cp9-rob-lucci" -maxdepth 2 -name "plan.md" 2>/dev/null
```

If results found, `AskUserQuestion`:

```
question    : "Found existing plan(s). Resume one or start a new task?"
header      : "Resume"
multiSelect : false
options     : <one option per found plan.md, label = first line of "## Goal" section, description = run_dir>
              + "Start new", description: "Start a new discovery from scratch"
```

**Resume an existing plan** → set `run_dir` to its directory. Skip to Step 3 (Present Plan).
**Start new** (or no existing runs found) → proceed to Step 1.

## Step 1 — Discover

1. Generate a slug:
   ```bash
   branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
   ticket=$(echo "$branch" | grep -oE '[A-Z]+-[0-9]+' | head -1)
   if [ -n "$ticket" ]; then
     slug="$ticket"
   else
     slug=$(echo "<task>" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-*//;s/-*$//' | cut -c1-50)
   fi
   run_dir="$(git rev-parse --show-toplevel)/.claude/agentic-state/runs/cp9-rob-lucci/$slug"
   mkdir -p "$run_dir"
   ```

2. Spawn `cp9-jabra-discovery`:
   ```
   mode: discover
   task: <the user's message verbatim>
   run_dir: <run_dir>
   <if spec_path is non-empty:>
   spec_path: <spec_path>
   ```

3. Wait for `## Discovery Written`. Proceed to Step 2.

## Step 2 — Discovery Loop

1. `Read` `<run_dir>/discovery.md` and show its full content to the user.

2. **If `## Clarifications Needed` is present** — jabra is uncertain about the goal or scope. Ask the user about each item using `AskUserQuestion` (batch up to 4 per call). Then spawn `cp9-jabra-discovery`:
   ```
   mode: deepen
   task: <original task>
   run_dir: <run_dir>
   focus: <the user's answers to the clarification questions>
   ```
   Wait for `## Discovery Written`. Restart Step 2 from the top.

3. **If `## Clarifications Needed` is absent** — `AskUserQuestion`:
   ```
   question    : "What do you want to do next?"
   header      : "Discovery"
   multiSelect : false
   options     :
     - label: "Dig deeper",  description: "Continue exploring with a specific focus"
     - label: "Build plan",  description: "I have enough context — let's plan"
   ```

4. **Dig deeper** → `AskUserQuestion`:
   ```
   question    : "What should the next round focus on?"
   header      : "Focus"
   multiSelect : false
   options     :
     - label: "Go broader",  description: "Explore related areas not yet covered"
     - label: "Go deeper",   description: "Drill further into what was already found"
   ```
   Spawn `cp9-jabra-discovery`:
   ```
   mode: deepen
   task: <original task>
   run_dir: <run_dir>
   focus: <selected option or Other text>
   ```
   Wait for `## Discovery Written`. Restart Step 2 from the top.

5. **Build plan** → proceed to Step 3.

## Step 3 — Plan

1. `AskUserQuestion`:
   ```
   question    : "What should the plan address? cp9-fukurou-planner will read the discovery findings for full context."
   header      : "Task"
   multiSelect : false
   options     :
     - label: "Address what we found",  description: "Let the planner derive the task from discovery.md"
   ```
   Use the selected label or Other text as the `task` for the planner.

2. Spawn `cp9-fukurou-planner`:
   ```
   mode: plan
   task: <task from above>
   run_dir: <run_dir>
   spec_path: <run_dir>/discovery.md
   spec_instruction: Read discovery.md before planning. Use it as the source of truth for findings and hypotheses. Do not re-derive what jabra already found.
   ```

3. Wait for `## Plan Written`. Proceed to Step 4.

## Step 4 — Present Plan

`plan.md` follows the schema in `$CLAUDE_PLUGIN_ROOT/reference/cp9/lucci-plan-format.md` — `## Open Questions` is the only section this skill branches on.

1. `Read` `<run_dir>/plan.md` and show its full content to the user.

2. **If `## Open Questions` is present** — **do NOT resolve them yourself.** Ask the user directly, then spawn `cp9-fukurou-planner`:
   ```
   mode: revise
   run_dir: <run_dir>
   feedback: <the user's answers>
   ```
   Wait for `## Plan Written`, then restart Step 4 from the top.

3. **Once `## Open Questions` is absent**, `AskUserQuestion`:
   ```
   question    : "Review the plan above. How do you want to proceed?"
   header      : "Plan Review"
   multiSelect : false
   options     :
     - label: "Approve",  description: "Build exactly as planned"
     - label: "Discuss",  description: "Ask questions or talk through changes before deciding"
     - label: "Cancel",   description: "Stop here — plan stays on disk for later resume"
   ```

   - **Approve** → proceed to Step 5.
   - **Discuss** → converse with the user. When settled, ask whether the plan needs updating:
     - **Yes** → spawn `cp9-fukurou-planner` (`mode: revise`, `feedback: <discussion summary>`). Wait for `## Plan Written`, restart Step 4.
     - **No** → return to this `AskUserQuestion` without re-spawning.
   - **Cancel** → tell the user the plan is saved at `<run_dir>/plan.md` and can be resumed by re-running `/cp9-rob-lucci`. Stop.

## Step 5 — Build

**NEVER spawn `cp9-kaku-worker` without an explicit `Approve` from Step 4.**

Spawn `cp9-kaku-worker`:
```
plan_path: <run_dir>/plan.md
run_dir: <run_dir>
```

Wait for `## Build Complete`. Relay its `### Files Changed` and `### Notes` to the user verbatim.
