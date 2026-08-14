---
name: developer-clear-runs
description: Remove all strategist run state from .claude/agentic-state/developer/feature-plans/. Clears stale state.json and stateholder-contract.md artifacts left by feature-strategist and other strategists.
user-invocable: true
disable-model-invocation: true
allowed-tools: Bash
---

Remove all run state artifacts from `.claude/agentic-state/developer/feature-plans/`.

## What this clears

`.claude/agentic-state/developer/feature-plans/` holds per-feature strategist state written during a session:
- `state.json` — completed phases and artifact paths
- `stateholder-contract.md` — shared context passed between workers

Stale entries from completed or abandoned sessions accumulate here and can cause strategists to skip phases they've already recorded as done, even in a fresh session on a new feature.

## Step 0 — Resolve Working Context

Run before anything else. Full protocol: `$CLAUDE_PLUGIN_ROOT/reference/aegis/working-context.md`.

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/aegis-resolve-context/resolve_context.py" \
  --taxonomy="$CLAUDE_PLUGIN_ROOT/reference/cipherpol.json" \
  --hint="<user message verbatim>"
```

Hold `project_root`, `platform`, `cp1_slug`, and `state_dir` for the whole run and
pass all four in every agent spawn. On `source=ambiguous`, present the `candidate=`
lines via `AskUserQuestion` (one option each, `label` = project, `description` =
`<platform> · <path>`) and re-run with `--repo=<chosen>`. On an `error=` line with
no candidates, tell the user to run `/aegis-setup-cipherpol` and stop. Then echo:

```
▸ <project> · <platform> · <project_root>
```

## Steps

1. Resolve the target directory from the Working Context. Every later step reuses `$TARGET` — never re-spell the path by hand:
```bash
TARGET="<state_dir>/developer/feature-plans"
```

2. List what will be removed, and count it (show the user before deleting):
```bash
find "$TARGET" -mindepth 1 -maxdepth 1 -type d 2>/dev/null
BEFORE=$(find "$TARGET" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
echo "$BEFORE run director(ies)"
```

> Use `find`, not a `*/` glob. Under zsh an unmatched glob aborts the command before it
> runs and prints `no matches found` to the shell's own stderr, which `2>/dev/null` on the
> command cannot suppress. `find` returns cleanly on an empty directory, and `-type d`
> states the subdirectories-only intent outright instead of leaning on a trailing slash.

3. If `$BEFORE` is `0`, report that there is nothing to clear and stop. Otherwise show the listing and ask the user to confirm before deleting.

4. Remove all run subdirectories:
```bash
find "$TARGET" -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +
```

5. Confirm the directory is now empty — this must print `0`:
```bash
find "$TARGET" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' '
```

Report the count from step 2 as the number of entries removed. If step 5 prints anything other than `0`, report a failure with the remaining entries — never claim success on an unverified delete.

## Note

This does not touch `.claude/agentic-state/.session-id`, which is managed by the `require-feature-strategist` hook automatically.

It clears run *subdirectories* only. Loose files directly under `feature-plans/` — notably `error.md` — are left in place, as is `.claude/agentic-state/developer/debug/`, which holds debug runs and their investigation records.
