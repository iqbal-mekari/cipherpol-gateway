---
name: aegis-resolve-context
description: Resolve the Working Context for a run — project_root, platform, project, cp1_slug, and state_dir. Walks a six-rung ladder from explicit argument down to workspace scan; yields the choice to the caller when several repos remain plausible.
user-invocable: false
allowed-tools: Bash
---

Resolve **where** a run operates and **what** it operates on, so no agent has to
infer either from its own working directory. Replaces `aegis-detect-platform`,
which returned identity only.

## Run

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/aegis-resolve-context/resolve_context.py" \
  --taxonomy="$CLAUDE_PLUGIN_ROOT/reference/cipherpol.json" \
  [--repo=<id|path>] [--hint="<user message>"] [--path=<arg path>]... [--platform=<cp1_slug>]
```

Pass every flag the caller has. Omitted flags just skip their rung.

| Flag | Pass when |
|---|---|
| `--repo` | The user gave `--repo=<id>`, or a context was already pinned this session |
| `--hint` | Always, if a user message exists — verbatim |
| `--path` | Once per local path in `arguments` (repeatable) |
| `--platform` | The workflow only applies to one platform |

## Ladder

Resolved by the script, in order; first hit wins. Only the last rung involves the user.

| # | Condition | `source=` |
|---|---|---|
| 0 | `CIPHERPOL_PROJECT_ROOT` set to a real directory | `env` |
| 1 | `--repo` matches a known project id or a real path | `explicit` |
| 2 | CWD is inside a git repo carrying a platform marker | `cwd` |
| 3 | `--hint` names exactly one known project | `message` |
| 4 | `--path` args land inside exactly one known repo | `inputs` |
| 5 | Exactly one manifest repo matches `--platform` | `manifest` |
| 6 | Several candidates remain | `ambiguous` |

Rung 2 reproduces the pre-manifest behavior exactly, so a developer working inside
a repo resolves fully with **no manifest and no env vars**. `CIPHERPOL_PLATFORM` /
`CIPHERPOL_PROJECT` / `CIPHERPOL_CP1_SLUG` still refine identity on rungs 0 and 2.

## Output

Six `key=value` lines:

```
project_root=/Users/dev/Workspace/mekari/mobile-talenta
platform=flutter
project=mobile-talenta
cp1_slug=mobile-talenta
state_dir=/Users/dev/Workspace/mekari/mobile-talenta/.claude/agentic-state
source=cwd
```

An empty `cp1_slug` means the project is not in `cipherpol.json` — callers then
skip the project tier and use `_global` only (see `cp1-retrieval.md`).

## When `source=ambiguous`

The script cannot prompt — `AskUserQuestion` is stripped from every agent, so the
choice is **yielded to the caller** rather than attempted here. Instead of a
context block it prints one line per candidate:

```
source=ambiguous
candidate=mobile-talenta	flutter	/Users/dev/Workspace/mekari/mobile-talenta
candidate=talenta-ios	ios	/Users/dev/Workspace/mekari/talenta-ios
```

The calling orchestrator presents these via `AskUserQuestion` (one option per
candidate, `label` = project, `description` = `<platform> · <path>`), then re-runs
this skill with `--repo=<chosen>` and pins the result for the rest of the session.

If an `error=` line appears with no candidates, no repos were discoverable — tell
the user to add `workspace_roots` to `~/.claude/cipherpol-workspace.json` (or run
`/aegis-setup-cipherpol`) and stop.

## Echo

Every caller prints one line before starting work, on every rung including silent ones:

```
▸ mobile-talenta · flutter · ~/Workspace/mekari/mobile-talenta
```

A statement, not a question. This is what makes silent resolution safe: without
it, a wrong inference surfaces only after a full planning cycle produces a plan
citing files from another repo.
