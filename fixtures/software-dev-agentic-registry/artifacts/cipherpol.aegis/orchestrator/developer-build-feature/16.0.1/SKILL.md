---
name: developer-build-feature
description: Build a feature from an approved plan or spec — spawns a scope agent to decompose work into batches, executes each batch with parallel workers (feature or ui), then asks whether to generate tests and syncs docs.
user-invocable: true
disable-model-invocation: true
allowed-tools: Agent, AskUserQuestion, Bash, Read
---

## Contract

Standalone entry point for the feature-execution workflow. This skill owns no logic
of its own — the workflow lives in `procedure.md` beside this file so that
`/developer-plan-build-feature`, `/developer-brainstorming`, and
`/developer-brainstorm-build-feature` can execute the identical steps without
invoking this skill. That keeps every entry point `disable-model-invocation: true`.

## Execute

Load the procedure — the shell expands `$CLAUDE_PLUGIN_ROOT`, so use Bash rather than `Read`:

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/developer-build-feature/procedure.md"
```

Follow it end to end with this input:

- `input_path` — `$ARGUMENTS`
