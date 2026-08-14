---
name: developer-fetch-figma
description: Fetch Figma frames — validates and expands Figma URLs, fetches frames via Figma MCP in parallel, groups them by visual structure, optionally aligns UI Stacks to the design system, and outputs a figma_fetch_dir that downstream skills can reuse to skip re-fetching.
user-invocable: true
disable-model-invocation: true
allowed-tools: Agent, AskUserQuestion, Bash
---

## Contract

Standalone entry point for the Figma-fetch workflow. This skill owns no logic of its
own — the workflow lives in `procedure.md` beside this file so that
`/developer-plan-feature` and `/developer-breakdown-requirement` can execute the
identical steps without invoking this skill. That keeps every entry point
`disable-model-invocation: true`.

## Execute

Load the procedure — the shell expands `$CLAUDE_PLUGIN_ROOT`, so use Bash rather than `Read`:

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/developer-fetch-figma/procedure.md"
```

Follow it end to end with this input:

- `arguments` — `$ARGUMENTS`
