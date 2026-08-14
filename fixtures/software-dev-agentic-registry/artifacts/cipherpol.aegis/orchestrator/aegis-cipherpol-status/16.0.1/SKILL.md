---
name: aegis-cipherpol-status
description: Full CipherPol health check — shows platform, project, plugin versions, cp-1 knowledge connectivity, and knowledge coverage for the current project.
user-invocable: true
disable-model-invocation: true
allowed-tools: Bash, Read, Glob, mcp__plugin_cipherpol-1_cp1__search_docs, mcp__plugin_cipherpol-1_cp1__list_projects, mcp__cp1-dev__search_docs, mcp__cp1-dev__list_projects
---

Run every step in order. Collect all results, then print a single combined report.

## Step 1 — Resolve context

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/aegis-resolve-context/resolve_context.py" \
  --taxonomy="$CLAUDE_PLUGIN_ROOT/reference/cipherpol.json"
echo "$CIPHERPOL_THINKER_MODEL"
ls "$HOME/.claude/cipherpol-workspace.json" 2>/dev/null || echo "(no workspace manifest)"
```

Take `PLATFORM`, `PROJECT`, `PROJECT_ROOT`, `CP1_SLUG`, and `SOURCE` from the
resolver's output. `THINKER_MODEL` comes from `$CIPHERPOL_THINKER_MODEL` — unset
or anything other than `cost-saving` means `optimized` (default).

If the resolver prints `source=ambiguous`, report the context block as
`⚠ unresolved` and list the candidates — this is a status report, so **do not**
prompt the user to pick one. If it prints an `error=` line with no candidates,
report that no workspace manifest covers this machine and point at
`/aegis-setup-cipherpol`.

## Step 2 — Plugin versions

```bash
claude plugin list 2>/dev/null | grep cipherpol || true
```

Check for `cipherpol-aegis` and `cipherpol-1` in the output. Note versions. The `cp1` knowledge server ships with the `cipherpol-1` plugin — if that plugin is absent, cp-1 knowledge is unavailable.

## Step 3 — cp-1 connectivity

`CP1_SLUG` already came from Step 1. An empty value means the project is absent
from `cipherpol.json` — report it, and expect the project tier to be skipped.

Probe with the plugin server first, falling back to `cp1-dev` (see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`):
- `list_projects()` — if the tool is unavailable or the call errors (connection / 401) on **both** servers → cp-1 is OFFLINE.
- If ONLINE: note the indexed slugs and whether `_global` and `CP1_SLUG` appear.

## Step 4 — Scoped knowledge probe

Using resolved `PLATFORM` and `CP1_SLUG`:

```
search_docs(slug="_global", query="standard architecture domain data presentation", platform=["{PLATFORM}"], doc_type=["standard"], k=6)
search_docs(slug="{CP1_SLUG}", query="deviations feature inventory shared components", doc_type=["reference"], k=6)   ← skip if CP1_SLUG empty
```

Report, for each call, the number of results and the distinct heading-breadcrumb roots returned (e.g. `Standard Architecture`, `Deviations`, `Feature Inventory`).

## Step 5 — Project knowledge snapshot

From the project-scoped probe (Step 4), take the first two distinct results with meaningful bodies (skip any under 100 characters) and show a 2–3 line excerpt of each, labelled with its breadcrumb.

## Report

Print one combined report. Do not add text beyond the blocks below.

```
CipherPol Status
══════════════════════════════════════════════════════

Context
───────────────────────────────────────────────────────
Project root   {PROJECT_ROOT}
Platform       {PLATFORM} (cp1_slug)
Project        {PROJECT}              cp-1 slug: {CP1_SLUG | "(none — project tier skipped)"}
Resolved via   {SOURCE}               (env | explicit | cwd | message | inputs | manifest)
Manifest       {~/.claude/cipherpol-workspace.json | "(none — CWD resolution only)"}
Thinker model  {THINKER_MODEL}        (opus planners/strategists | sonnet if cost-saving)
⚠ unresolved: several repos match — <candidates>   ← only when source=ambiguous

Plugins
───────────────────────────────────────────────────────
cipherpol-aegis   {version | ✗ not installed}
cipherpol-1       {version | ✗ not installed}   ← ships the cp1 knowledge server

cp-1 knowledge: {ONLINE | OFFLINE}
───────────────────────────────────────────────────────
server: {plugin cp1 | cp1-dev fallback}
indexed slugs: {list}   (_global {✓|✗}, {CP1_SLUG} {✓|✗ not indexed})

Knowledge probe — platform: {PLATFORM}  slug: {CP1_SLUG | —}
──────────────────────────────────────────────────────
_global standard   {N results}   sections: {breadcrumb roots}
project reference  {N results | ⚠ 0 — project not indexed}   sections: {breadcrumb roots}

Project snapshot — {CP1_SLUG}
──────────────────────────────────────────────────────
{breadcrumb_1}   {2–3 line excerpt | ⚠ empty body}
{breadcrumb_2}   {2–3 line excerpt | ⚠ empty body}
```

**Flags:**
- `⚠ conflict` — env var and CLAUDE.md disagree; env var takes precedence
- `⚠ not installed` — plugin missing; run `install-plugin.sh`
- `⚠ 0 results` on project probe — the project isn't indexed in cp-1; index it with the `cp1-index-project` skill (cipherpol-1)
- `⚠ empty body` — result body under 100 chars; the doc may be a stub

**cp-1 OFFLINE block:**
```
cp-1 knowledge: OFFLINE
  search_docs unavailable on both the plugin cp1 server and cp1-dev. Ensure the cipherpol-1 plugin is enabled and $CP1_AUTH_TOKEN is set (a 401 means the token is unset/stale), then restart Claude Code.
```
