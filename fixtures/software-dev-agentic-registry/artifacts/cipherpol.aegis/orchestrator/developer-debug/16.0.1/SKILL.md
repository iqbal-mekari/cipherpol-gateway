---
name: developer-debug
description: Debug a bug — collects intake (error message, expected vs actual behavior, entry point, platform), then runs a user-driven session loop (instrument · reproduce · revise) until the user wraps up. On wrap-up it strips the debug logs it added and offers to record the root cause and fix recommendation to a ticket as a Progress Tracker entry.
user-invocable: true
disable-model-invocation: true
allowed-tools: Agent, AskUserQuestion, Bash
---

## Contract

Standalone entry point for the debugging workflow. This skill owns no logic of its
own — the workflow lives in `procedure.md` beside this file so that
`/developer-plan-feature` and `/developer-groom-ticket` can execute the identical
steps without invoking this skill. That keeps every entry point
`disable-model-invocation: true`.

## Execute

Load the procedure — the shell expands `$CLAUDE_PLUGIN_ROOT`, so use Bash rather than `Read`:

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/developer-debug/procedure.md"
```

Follow it end to end with this input:

- `bug_description` — `$ARGUMENTS`

Leave `ticket_path` unset — the procedure asks for one in Step 6, and only if the
user chooses to record the findings, so a throwaway investigation never has to
answer for a ticket.
