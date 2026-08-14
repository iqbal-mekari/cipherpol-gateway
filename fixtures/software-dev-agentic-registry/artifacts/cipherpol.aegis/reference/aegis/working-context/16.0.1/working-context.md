> Related: [aegis-resolve-context skill](../skills/procedures/aegis-resolve-context/SKILL.md) · [cp1-retrieval.md](./cp1-retrieval.md)

# Working Context

The block every orchestrator resolves **once**, before any agent is spawned, and
then threads to every agent it spawns. It answers both questions an aegis run
needs — *what* is being worked on and *where* it lives on disk.

| Field | Meaning |
|---|---|
| `project_root` | Absolute path to the repo this run operates on |
| `platform` | cp1_slug — `flutter` / `ios` / `android` / `web` |
| `project` | Project id |
| `cp1_slug` | cp-1 doc-store slug for the project tier. May be empty → skip that tier |
| `state_dir` | `<project_root>/.claude/agentic-state` — every run artifact lands under here |
| `source` | Which ladder rung resolved it (diagnostics) |

---

## Why this exists

Before this contract, agents derived both facts from their own working directory
(`git rev-parse --show-toplevel`, `basename $(pwd)`, bare relative `Glob`). That
works only when the session is launched from inside the target repo. Launched
from a workspace folder holding several clones, the same code fails three ways:

1. `git rev-parse` exits non-zero — the workspace folder is not a repo.
2. Run state lands in the workspace folder, orphaned from the repo it describes.
3. **Worst, and silent:** a relative `Glob`/`Grep` matches sibling repos, so a
   planner synthesizes a plan from a mixture of codebases. Nothing errors; the
   plan simply cites files the run never touched.

Resolving once and passing the result down removes all three. It also makes
multi-repo runs expressible — two agents, two contexts, one session.

---

## Step 0 — the orchestrator's obligation

Every Type O entry point runs this before anything else:

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/aegis-resolve-context/resolve_context.py" \
  --taxonomy="$CLAUDE_PLUGIN_ROOT/reference/cipherpol.json" \
  --hint="<user_message verbatim>" \
  [--repo=<id>] [--path=<each local path in arguments>]... [--platform=<cp1_slug>]
```

Pass `--repo` when the user gave one or a context is already pinned this session;
`--path` once per local path in `arguments`; `--platform` when the workflow only
applies to one platform. See the skill for the full six-rung ladder.

**On `source=ambiguous`** — the script prints one `candidate=` line per repo
instead of a context block. Present them with `AskUserQuestion` (one option per
candidate, `label` = project, `description` = `<platform> · <path>`), then re-run
with `--repo=<chosen>`. A skill cannot prompt from inside an agent, so this
choice belongs to the orchestrator and nowhere else.

**On an `error=` line with no candidates** — no repos are discoverable. Tell the
user to run `/aegis-setup-cipherpol` or add `workspace_roots` to
`~/.claude/cipherpol-workspace.json`, and stop.

**Pin it.** Resolve once per session. A follow-up skill in the same session
(`/developer-plan-feature` → `/developer-build-feature`) reuses the resolved
context and must not ask again.

---

## The echo line

Print exactly one line before starting work, on every rung including silent ones:

```
▸ mobile-talenta · flutter · ~/Workspace/mekari/mobile-talenta
```

A statement, not a question. Silent inference is only safe because this line
exists: without it, a wrong guess surfaces after a full planning cycle, as a plan
citing files from another repo. `--repo=<id>` overrides and re-pins.

---

## Threading

`project_root`, `state_dir`, and `cp1_slug` join `platform`, `module_path`, and
`run_dir` in the input block of **every** agent spawn. Agents never re-derive
them. Two rules follow:

- Every path an agent writes is `<state_dir>/…` or `<project_root>/…` — never a
  bare relative path, never `$(git rev-parse …)`.
- Every agent holding `Glob` or `Grep` scopes its patterns under `project_root`.
  A relative pattern is the silent failure above.
