---
name: developer-brainstorming
description: Turn an idea into a concrete design and spec before implementation — drives a collaborative dialogue (one question at a time), proposes approaches, presents a design for approval, writes a spec, then executes the build workflow.
user-invocable: true
disable-model-invocation: true
allowed-tools: Agent, AskUserQuestion, Bash, Read, Write, Edit, WebFetch
---

## Contract

Standalone entry point for the brainstorming workflow. This skill owns no logic of its
own — the workflow lives in `procedure.md` beside this file so that
`/developer-brainstorm-build-feature` can execute the identical steps without
invoking this skill. That keeps both entry points `disable-model-invocation: true`.

## Execute

Load the procedure — the shell expands `$CLAUDE_PLUGIN_ROOT`, so use Bash rather than `Read`:

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/developer-brainstorming/procedure.md"
```

Follow it end to end with these inputs:

- `arguments` — `$ARGUMENTS`
- `on_approval` — `build`

`on_approval: build` is what makes this the standalone path: there is no caller waiting
to pick the spec up, so the procedure runs the build workflow itself after spec approval.
