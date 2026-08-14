---
name: developer-plan-feature
description: Plan a feature — resolves external inputs (Jira, PRD, Figma, local .md), gathers intent, runs the convergence planning loop, and shows an interactive approval prompt. On approval, writes plan.md with status approved and outputs a ## Plan Output block with run_dir.
user-invocable: true
disable-model-invocation: true
allowed-tools: Agent, AskUserQuestion, Bash, Read, WebFetch
---

## Contract

Standalone entry point for the feature-planning workflow. This skill owns no logic
of its own — the workflow lives in `procedure.md` beside this file so that
`/developer-plan-build-feature` can execute the identical steps without invoking
this skill. That keeps both entry points `disable-model-invocation: true`.

## Execute

Load the procedure — the shell expands `$CLAUDE_PLUGIN_ROOT`, so use Bash rather than `Read`:

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/developer-plan-feature/procedure.md"
```

Follow it end to end with these inputs:

- `arguments` — `$ARGUMENTS`
- `user_message` — the full user message verbatim

Return its `## Plan Output` block verbatim.
