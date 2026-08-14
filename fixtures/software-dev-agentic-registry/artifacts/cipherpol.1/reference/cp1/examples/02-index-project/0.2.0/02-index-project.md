# Example: Index a new project

> Uses the `cp1-index-project` skill's script — not an MCP tool call, since
> indexing needs local disk access that the shared remote server doesn't have.

**User:** Index my-app at /path/to/my-app on branch main

**Claude uses:**
```bash
SUPABASE_URL="<url>" SUPABASE_SERVICE_ROLE_KEY="<key>" \
  bash skills/cp1-index-project/scripts/index-project.sh \
  ~/mobile-agentic-toolkit /path/to/my-app my-app branch:main
```

**Tips:**
- The script always passes `--include-source` (richer search, recommended for repos under ~200k LOC)
- Re-running is safe — only changed symbols are re-embedded (content-hash gated, shows as `embeddedNew: 0` when nothing changed)
- First run against a fresh checkout is slower (clones the repo + `pnpm install`)
