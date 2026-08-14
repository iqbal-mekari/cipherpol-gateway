---
name: developer-sync-docs
description: Sync documentation for a completed developer run on demand — resolves the run, evaluates the docs-sync gate, and spawns the docs worker only when a sync is warranted. Also the shared procedure that the build and debug flows run as their tail step.
user-invocable: true
disable-model-invocation: true
allowed-tools: Agent, Bash, AskUserQuestion
---

## Contract

Standalone entry point for the docs-sync workflow. This skill owns no logic of its
own — the workflow lives in `procedure.md` beside this file so that
`/developer-build-feature`, `/developer-debug`, and `/developer-build-from-ticket`
can execute the identical steps without invoking this skill. That keeps every entry
point `disable-model-invocation: true`.

## Execute

First resolve the Working Context — full protocol:
`$CLAUDE_PLUGIN_ROOT/reference/aegis/working-context.md`.

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/aegis-resolve-context/resolve_context.py" \
  --taxonomy="$CLAUDE_PLUGIN_ROOT/reference/cipherpol.json" \
  --hint="<user message verbatim>"
```

On `source=ambiguous`, present the `candidate=` lines via `AskUserQuestion` and
re-run with `--repo=<chosen>`. Echo `▸ <project> · <platform> · <project_root>`.

Then load the procedure — the shell expands `$CLAUDE_PLUGIN_ROOT`, so use Bash rather than `Read`:

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/developer-sync-docs/procedure.md"
```

Follow it end to end with these inputs:

- `run_hint` — `$ARGUMENTS` (a run slug or absolute path; may be empty)
- `invocation` — `manual`
- `interactive` — `true`
- `project_root` — from the Working Context above
- `state_dir` — from the Working Context above

Leave `run_dir`, `mode`, and `ticket_key` unset — the procedure resolves them.
