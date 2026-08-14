---
name: aegis-setup-cipherpol
description: Provision a machine to use the CipherPol toolkit — creates the agentic-state run dir, adds it to the global gitignore, registers the cipherpol marketplace, enables the toolkit plugins (excluding the retired cipherpol-8), and wires the localizations MCP and (on a toolkit checkout) the cp1-dev fallback. Idempotent — safe to re-run.
user-invocable: true
disable-model-invocation: true
allowed-tools: Bash, Read, AskUserQuestion
---

One-time (idempotent) environment setup for the toolkit. Runs a dry-run first,
shows the plan, gets confirmation, then applies. Never overwrites a value that is
already set (tokens, existing MCP entries). Secrets are written as placeholders —
the user fills them in afterward.

`cp1` (the remote knowledge server) is **not** configured here — it ships with the
`cipherpol-1` plugin. Adding a manual `cp1` MCP entry would collide with the
plugin's bundled server, so this skill deliberately does not.

## Step 0 — Resolve the toolkit checkout (for dev-only wiring)

The `cp1-dev` fallback MCP and the `cipherpol-dev` marketplace only apply when the
user has this toolkit repo cloned locally. Resolve it, in order:

```bash
TK="${1:-${CIPHERPOL_TOOLKIT_DIR:-}}"
if [ -z "$TK" ]; then
  # autodetect: is the current git repo (or cwd) a toolkit checkout?
  root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  [ -f "$root/cipherpol-1/packages/mcp-server/src/server.ts" ] && TK="$root"
fi
if [ -n "$TK" ] && [ -f "$TK/cipherpol-1/packages/mcp-server/src/server.ts" ]; then
  echo "toolkit: $TK"
  [ -x "$TK/cipherpol-1/node_modules/.bin/tsx" ] && echo "cp1-dev: ready" || echo "cp1-dev: tsx missing — run 'pnpm --dir $TK/cipherpol-1 install' first"
else
  echo "toolkit: (none) — cp1-dev + cipherpol-dev skipped; downstream setup only"
fi
```

Hold `TK` (may be empty) for later steps.

## Step 1 — Preview (dry-run)

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/aegis-setup-cipherpol/setup_cipherpol.py" --dry-run \
  --invocation-rules-template "$CLAUDE_PLUGIN_ROOT/reference/aegis/invocation-rules.md" \
  --skills-root "$CLAUDE_PLUGIN_ROOT/skills" \
  [--workspace-root=<dir>]...
```

`--workspace-root` is the directory holding repo clones side by side (e.g.
`~/Workspace/mekari`). Omit it and the script infers the parent of the enclosing
git repo. It only ever *adds* roots — an existing list, and the `repos[]` cache
`aegis-resolve-context` maintains, are never rewritten.

(If `$CLAUDE_PLUGIN_ROOT` is unset, run the script by its path next to this SKILL.md.)

Then read current CLI state so the plan is complete:

```bash
claude plugin marketplace list 2>/dev/null | grep -iE "cipherpol" || echo "(no cipherpol marketplace)"
claude plugin list 2>/dev/null | grep -iE "cipherpol|swift-lsp|context7|frontend-design" || true
claude mcp list 2>/dev/null | grep -iE "localizations-mcp|cp1-dev" || echo "(neither MCP configured)"
```

Present a single combined plan: the script's `PLAN` lines, plus which marketplaces/plugins/MCP servers will be added, and which are already present (skip). Mark `cp1-dev` and `cipherpol-dev` as skipped when `TK` is empty.

## Step 2 — Confirm

This modifies the user's **global** config. Use `AskUserQuestion` to confirm before applying (offer: apply / cancel). Skip the prompt only if the user already said to proceed without asking.

## Step 3 — Apply file setup

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/aegis-setup-cipherpol/setup_cipherpol.py" \
  --invocation-rules-template "$CLAUDE_PLUGIN_ROOT/reference/aegis/invocation-rules.md" \
  --skills-root "$CLAUDE_PLUGIN_ROOT/skills" \
  [--workspace-root=<dir>]...
```

`--workspace-root` is the directory holding repo clones side by side (e.g.
`~/Workspace/mekari`). Omit it and the script infers the parent of the enclosing
git repo. It only ever *adds* roots — an existing list, and the `repos[]` cache
`aegis-resolve-context` maintains, are never rewritten.

## Step 4 — Marketplace + plugins (CLI)

Only run an `add`/`install` when Step 1 showed it missing (the CLIs error on duplicates).

```bash
# marketplace(s)
claude plugin marketplace add git@bitbucket.org:mid-kelola-indonesia/mobile-agentic-toolkit.git
[ -n "$TK" ] && claude plugin marketplace add "$TK/dist/dev-marketplace"

# toolkit plugins — all enabled by default, cipherpol-8 excluded (retired)
for p in cipherpol-1 cipherpol-9 cipherpol-aegis; do claude plugin install "$p@cipherpol"; done
# recommended official plugins
for p in swift-lsp context7 frontend-design; do claude plugin install "$p@claude-plugins-official"; done

# retire cp8 if it lingers from a previous install
claude plugin uninstall cipherpol-8@cipherpol 2>/dev/null || true
```

## Step 5 — MCP servers (CLI, user scope)

```bash
# localizations — empty bearer on purpose; the teammate self-authenticates at
# https://mcp.aziz.work/login and pastes their token later.
claude mcp add --transport http --scope user localizations-mcp \
  https://mcp.aziz.work/localizations --header "Authorization: Bearer "

# cp1-dev fallback — ONLY on a toolkit checkout with tsx installed
if [ -n "$TK" ] && [ -x "$TK/cipherpol-1/node_modules/.bin/tsx" ]; then
  claude mcp add cp1-dev --scope user -- \
    "$TK/cipherpol-1/node_modules/.bin/tsx" \
    "$TK/cipherpol-1/packages/mcp-server/src/server.ts"
fi
```

Do **not** add a `cp1` entry — it comes from the `cipherpol-1` plugin.

## Report

Print one combined summary:

```
CipherPol setup
──────────────────────────────────────────
✓  run dir       .claude/agentic-state/ {created | present}
✓  gitignore     agentic-state/ in {global gitignore path}
✓  marketplace   cipherpol {added | present}{, cipherpol-dev … | ' (dev skipped — no toolkit)'}
✓  plugins       cipherpol-1, cipherpol-9, cipherpol-aegis enabled · cipherpol-8 excluded
✓  mcp           localizations-mcp added (token empty){, cp1-dev … | ' · cp1-dev skipped'}
✓  invocation-rules  .claude/cipherpol-invocation-rules.md {written | up to date | assimilated into <path>}
──────────────────────────────────────────
Manual follow-ups:
  1. Set CP1_AUTH_TOKEN in ~/.claude/settings.json → env (ask an admin for the token).
  2. Authenticate localizations: https://mcp.aziz.work/login → paste the token into the
     localizations-mcp Authorization header (or re-run `claude mcp add`).
  3. Restart Claude Code so the new plugins and MCP servers connect.
```

Adjust each line to what actually happened, including the `invocation-rules` line — report the actual
target path (its own file, or the foreign file it was assimilated into) and whether it was written,
already up to date, or assimilated. If the script printed any `WARN`, surface it verbatim.
