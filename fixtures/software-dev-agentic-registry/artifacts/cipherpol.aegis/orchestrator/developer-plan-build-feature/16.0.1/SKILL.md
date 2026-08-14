---
name: developer-plan-build-feature
description: Plan then build a feature — runs the planning workflow (figma fetch + convergence planning loop + approval), then on approval runs the build workflow to execute the approved plan.
user-invocable: true
disable-model-invocation: true
allowed-tools: Agent, AskUserQuestion, Bash, Read, WebFetch
---

## Contract

Composite entry point. This skill owns no logic of its own — it executes the same
two procedures that `/developer-plan-feature` and `/developer-build-feature` run,
by reading them directly rather than invoking those skills.

Reading the procedures instead of invoking the skills is deliberate: a skill with
`disable-model-invocation: true` cannot be reached by the Skill tool at all, so
composing via invocation would force both children to stay model-invocable and
therefore auto-triggerable. `procedure.md` files carry no frontmatter and no
invocation gate, so every skill in this chain stays `disable-model-invocation: true`.

Never read source files, search the codebase, or write code. All exploration,
planning, and implementation is delegated to the agents the procedures spawn.

## Step 1 — Plan

Load the planning procedure — the shell expands `$CLAUDE_PLUGIN_ROOT`, so use Bash rather than `Read`:

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/developer-plan-feature/procedure.md"
```

Follow it end to end with these inputs:

- `arguments` — `$ARGUMENTS`
- `user_message` — the full user message verbatim

When it finishes, read its `## Plan Output` block and extract `run_dir`.

If no `## Plan Output` is produced (the plan was discarded or canceled), stop.

## Step 2 — Build

Load the build procedure — the shell expands `$CLAUDE_PLUGIN_ROOT`, so use Bash rather than `Read`:

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/developer-build-feature/procedure.md"
```

Follow it end to end with this input:

- `input_path` — the `run_dir` extracted in Step 1
