---
name: developer-brainstorm-build-feature
description: Brainstorm then build a feature — runs /developer-brainstorming (explore context + clarify + design + spec approval), then on approval runs the build workflow to execute against the written spec.
user-invocable: true
disable-model-invocation: true
allowed-tools: Agent, AskUserQuestion, Bash, Read, Write, Edit, WebFetch
---

## Routing Contract

Composite entry point. It performs no direct operations of its own beyond routing.

## Step 1 — Brainstorm

Load the brainstorming procedure — the shell expands `$CLAUDE_PLUGIN_ROOT`, so use Bash rather than `Read`:

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/developer-brainstorming/procedure.md"
```

Follow it end to end with these inputs:

- `arguments` — `$ARGUMENTS`
- `on_approval` — `stop`

`on_approval: stop` is what makes this the composite path: the procedure emits
`## Brainstorm Output` and returns, leaving the build to Step 2 below rather than
running it itself.

Read the `## Brainstorm Output` block — extract `spec_path`.

If no `## Brainstorm Output` is present (brainstorming was canceled or the user chose a non-feature execution path), stop.

## Step 2 — Build

Load the build procedure — the shell expands `$CLAUDE_PLUGIN_ROOT`, so use Bash rather than `Read`:

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/developer-build-feature/procedure.md"
```

Follow it end to end with `input_path` = `<spec_path>` from Step 1.

> Read rather than invoke: `developer-build-feature` is `disable-model-invocation: true`, so the Skill tool cannot reach it. The procedure file carries no invocation gate.
