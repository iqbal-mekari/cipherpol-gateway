---
name: aegis-installer-doctor
description: Audit the CipherPol plugin setup in a downstream project — runs the manifest-driven AI baseline verifier when .claude/ai-baseline.json exists, falls back to heuristic checks otherwise, and always checks plugin installation and GitHub CLI auth.
user-invocable: true
disable-model-invocation: true
allowed-tools: Bash, Read, Glob
---

Audit the plugin setup. Collect all results, then print a single formatted report. Read-only — diagnose and suggest fixes, never auto-fix.

## Step 0 — Baseline manifest

```bash
test -f .claude/ai-baseline.json && echo "manifest present" || echo "no manifest"
```

- **Manifest present** — run the bundled verifier from the repo root; its results **replace** heuristic checks 2–5 below (still run checks 1, 6, and 7):

  ```bash
  python3 "$CLAUDE_PLUGIN_ROOT/skills/aegis-installer-doctor/verify_ai_setup.py" --environment
  ```

  If the skill is not running from an installed plugin (`$CLAUDE_PLUGIN_ROOT` unset), locate `verify_ai_setup.py` next to this SKILL.md and run it with its absolute path. The script is dependency-free Python 3.9+. `--manifest PATH` overrides the default manifest location; `--environment` shells out to `claude plugin marketplace list`, `claude plugin list`, `claude mcp list` (120s timeouts each) — drop it if the user asks for a committed-files-only audit.

  Interpret: exit 0 — every configured check passed (one `PASS:` line per area); exit 1 — one or more `ERROR:` lines, each naming the exact file/key or reference at fault (report **all** of them, verbatim, as `✗ baseline` rows); exit 2 — usage error.

- **No manifest** — run all heuristic checks below, and after the report offer to create `.claude/ai-baseline.json` from the schema at the bottom, pre-filled from the repo's current (reviewed) configuration.

## Heuristic checks

### 1. Plugin installed *(always run)*

```bash
cat .claude/settings.json 2>/dev/null
claude plugin list 2>/dev/null | grep cipherpol || true
```

`cipherpol-aegis` is required. `cipherpol-1` (the knowledge plugin, ships the `cp1` MCP) is **recommended** — an aegis-only setup is still healthy; agents simply skip platform/project knowledge lookups.

- Pass: `cipherpol-aegis` present in `settings.json` and installed
- Warn: `cipherpol-aegis` present in `settings.json` but not yet installed — run the install command
- Warn: `cipherpol-1` absent (knowledge lookups disabled — recommended; enable it and set `CP1_AUTH_TOKEN` if the project uses knowledge lookups)
- Fail: `cipherpol-aegis` missing from `settings.json`

### 2. Marketplace configured *(skip when manifest present)*

Check `~/.claude/settings.json` (global) for `extraKnownMarketplaces`, **and** the project's `.claude/settings.json` — a project may alternatively define the marketplace inline (`extraKnownMarketplaces.cipherpol` with a source of type `"settings"` pinning the Bitbucket url/sha); that also counts as configured.

- Pass: a `cipherpol` marketplace sourced from `git@bitbucket.org:mid-kelola-indonesia/mobile-agentic-toolkit.git` (or `bitbucket.org/mid-kelola-indonesia/mobile-agentic-toolkit` in any URL form) present in either location
- Fail: missing — run: `claude plugin marketplace add git@bitbucket.org:mid-kelola-indonesia/mobile-agentic-toolkit.git`
- Warn: a legacy `hndhr/software-dev-agentic` registration exists — remove it: `claude plugin marketplace remove` the legacy entry (or delete it from `extraKnownMarketplaces`)

### 3. skillListingBudgetFraction set *(skip when manifest present)*

```bash
grep "skillListingBudgetFraction" .claude/settings.json 2>/dev/null || true
```

- Pass: present (recommended: 0.03)
- Warn: missing — skill descriptions will be truncated; add `"skillListingBudgetFraction": 0.03` to `.claude/settings.json`

### 4. CLAUDE.md managed markers *(skip when manifest present)*

Check `CLAUDE.md` for `<!-- BEGIN software-dev-agentic -->` and `<!-- END software-dev-agentic -->`.

- Pass: both present
- Warn: one present but not the other
- Fail: neither present

### 5. .gitignore — agentic-state *(skip when manifest present)*

```bash
grep -q "agentic-state" .gitignore && echo "present" || echo "missing"
```

- Pass: `.claude/agentic-state/` in `.gitignore`
- Warn: missing — add `.claude/agentic-state/` to `.gitignore`

### 6. GitHub CLI auth *(always run)*

```bash
gh auth status 2>&1
```

- Pass: contains "Logged in"
- Fail: not logged in or `gh` not installed

### 7. Invocation rules in sync *(always run)*

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/aegis-setup-cipherpol/setup_cipherpol.py" --dry-run \
  --invocation-rules-template "$CLAUDE_PLUGIN_ROOT/reference/aegis/invocation-rules.md" \
  --skills-root "$CLAUDE_PLUGIN_ROOT/skills" \
  2>/dev/null | grep -i "invocation-rules" || true
```

This check runs unconditionally — it reuses the same script that would apply the fix, in
dry-run/read-only mode, consistent with this skill's "diagnose, never auto-edit" rule above.

- Pass: the matched line starts with `SKIP`
- Warn: the matched line starts with `PLAN` — fix: re-run `/aegis-setup-cipherpol`
- Warn: the matched line starts with `WARN` — surface it verbatim (template unreadable, likely a broken plugin install)

## Suggesting fixes for baseline errors

For each verifier `ERROR:` line, propose the minimal edit:

| Error mentions | Fix |
|---|---|
| `marketplace ... source must equal` | Align `extraKnownMarketplaces.<key>.source` in the settings file with the manifest (pinned url/sha) |
| `enabledPlugins` / `env` / `skillListingBudgetFraction` / `enabledMcpjsonServers` | Set the settings key to the exact manifest value |
| `mcpServers must match` | Diff the file's `mcpServers` against `mcp_servers` in the manifest; restore the approved definitions |
| `credential-like key` | Remove the secret from the committed file — credentials never belong in git (env vars in an `env` block are allowed) |
| `.gitignore must contain` | Append the listed pattern to `.gitignore` |
| `CLAUDE.md must contain` | Restore the required line (usually the managed Platform/Project markers) |
| `stale reference` | Update or remove the flagged line — legacy tool prefixes and personal absolute paths (`/Users/x/`, `/home/x/`) must not be committed |
| `forbidden marketplace` | `claude plugin marketplace remove <name>` |
| `required installed plugin is missing` | `claude plugin install <plugin>@<marketplace>` |
| `duplicate plugin` | Uninstall the copy from the other marketplace |
| `MCP server is not connected` | Check the server definition and restart Claude Code; verify with `claude mcp list` |

## Report format

With a manifest:

```
CipherPol doctor
──────────────────────────────────────────
✓  baseline      ai-baseline.json — settings, marketplace pin, MCP, gitignore, CLAUDE.md, reference scans pass
✗  baseline      stale reference "mcp__figma__" in CLAUDE.md:41 — update to the current tool prefix
✓  plugin        cipherpol-aegis@13.14.0 installed
⚠  plugin        cipherpol-1 not enabled — recommended knowledge plugin; enable it and set CP1_AUTH_TOKEN if the project uses knowledge lookups
✓  gh auth       logged in
⚠  invocation-rules  stale — rerun /aegis-setup-cipherpol
──────────────────────────────────────────
1 error · 2 warnings
```

Without a manifest:

```
CipherPol doctor
──────────────────────────────────────────
✓  plugin        cipherpol-aegis@13.14.0 installed
⚠  plugin        cipherpol-1 not enabled — recommended knowledge plugin; enable it and set CP1_AUTH_TOKEN if the project uses knowledge lookups
✓  marketplace   cipherpol → bitbucket.org/mid-kelola-indonesia/mobile-agentic-toolkit configured
⚠  budget        skillListingBudgetFraction missing — add 0.03 to .claude/settings.json
✓  CLAUDE.md     managed markers found
✓  .gitignore    agentic-state/ present
✓  gh auth       logged in
✓  invocation-rules  in sync
──────────────────────────────────────────
2 warnings

No .claude/ai-baseline.json found — want me to create one from the current configuration?
```

Rules:
- `✓` pass · `⚠` warning (non-blocking) · `✗` error (breaks functionality)
- Each line: symbol · category (padded to 14 chars) · message · fix command if applicable
- Summary: error + warning counts. If all pass: `All checks passed.`
- Never edit project files while diagnosing; apply fixes only when the user asks.

## Manifest schema

`.claude/ai-baseline.json` — every section is optional; absent sections are skipped:

```json
{
  "settings_path": ".claude/settings.json",
  "mcp_path": ".mcp.json",
  "marketplace": {
    "key": "cipherpol",
    "source": {
      "source": "git-subdir",
      "url": "git@bitbucket.org:mid-kelola-indonesia/mobile-agentic-toolkit.git",
      "path": "dist/plugins/cipherpol-aegis",
      "sha": "<pinned commit sha>"
    }
  },
  "enabled_plugins": { "cipherpol-aegis@cipherpol": true },
  "env": { "CIPHERPOL_PLATFORM": "flutter", "CIPHERPOL_PROJECT": "my_project" },
  "skill_listing_budget_fraction": 0.03,
  "mcp_servers": {
    "Figma MCP": { "type": "http", "url": "https://mcp.figma.com/mcp" },
    "atlassian": { "type": "http", "url": "https://mcp.atlassian.com/v1/mcp" }
  },
  "enabled_mcpjson_servers": ["Figma MCP", "atlassian"],
  "gitignore_required": [".claude/agentic-state/", ".claude/settings.local.json"],
  "claude_md_required_lines": ["**Platform:** flutter", "**Project:** my_project"],
  "stale_references": ["mcp__figma__", "mcp__claude_ai_Atlassian__"],
  "scan_paths": [".claude", ".mcp.json", "CLAUDE.md"],
  "forbidden_marketplaces": ["hndhr/software-dev-agentic", "cipherpol-zero"],
  "required_installed_plugins": ["cipherpol-aegis@cipherpol"],
  "expected_connected_mcp": ["Figma MCP", "atlassian"]
}
```

Section semantics:

- `marketplace.source` — compared **exactly** (deep equality) against `extraKnownMarketplaces[key].source` in `settings_path`
- `enabled_plugins`, `env`, `mcp_servers` — exact object equality; `skill_listing_budget_fraction`, `enabled_mcpjson_servers` — exact value/list equality. `enabled_mcpjson_servers` additionally requires `enableAllProjectMcpServers: false`
- `mcp_servers` presence also triggers a recursive scan of the whole MCP file for credential-like keys (header/token/secret/authorization/apikey/password/cookie/credential; a key named exactly `env` is allowed)
- `scan_paths` — directories are expanded to their **git-tracked** files; file entries are scanned even when untracked. Every scanned line is checked for `stale_references` substrings (case-insensitive) and personal absolute paths. The manifest file itself is exempt (it legitimately names the stale strings)
- `forbidden_marketplaces`, `required_installed_plugins`, `expected_connected_mcp` — only checked with `--environment`. Required plugins use `name@marketplace` form; the same plugin installed from any *other* marketplace is reported as a duplicate; expected MCP servers must show `Connected` in `claude mcp list`
