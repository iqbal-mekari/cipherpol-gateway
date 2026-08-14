# cipherpol-1 — Claude Code Plugin

A self-hosted GraphRAG knowledge base that indexes your codebases via tree-sitter → symbol graph → embeddings. Search code, store session learnings, and recall project knowledge — backed by a shared team server, no per-user setup for search.

## What's included

| Item                                 | What it does                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| **MCP server (`cp1`)**               | Remote — connects to the team's hosted instance, no local Docker/Supabase needed |
| **Skill: `cp1-use-knowledge-base`**  | Full MCP tools reference + common workflows                                      |
| **Skill: `cp1-index-project`**       | Indexes/re-indexes a project via a local script (no MCP server needed for this)  |
| **Skill: `cp1-delete-project`**      | Deletes a project/snapshot via a local script (needs the service-role key)       |
| **Skill: `cp1-distill-session`**     | Bulk-extract session learnings into typed memories                               |
| **Agent: `cp1-codebase-explorer`**   | Answers questions about any indexed codebase                                     |

---

## Setup (one-time, ~2 minutes)

This plugin ships pre-configured to talk to the team's hosted server — you just need the access token.

### 1. Get the token

Ask whoever administers the knowledge base for the bearer token value.

### 2. Export it as `CP1_AUTH_TOKEN`

The plugin's `.mcp.json` reads the token from your environment rather than storing it,
so it survives plugin upgrades and never lands in git:

```json
{
  "mcpServers": {
    "cp1": {
      "type": "http",
      "url": "https://vps.marcelldr.web.id/mcp",
      "headers": {
        "Authorization": "Bearer ${CP1_AUTH_TOKEN}"
      }
    }
  }
}
```

Set it in `~/.claude/settings.json`, which Claude Code reads however it was launched:

```json
{
  "env": {
    "CP1_AUTH_TOKEN": "<token>"
  }
}
```

A shell export (`~/.zshrc`) also works, but **only when you launch `claude` from a
terminal** — the desktop app does not source your shell profile, so the server
silently fails to connect. Prefer `settings.json`.

Treat this like a password — don't commit it or share it outside the team.

### 3. Restart Claude Code

The `cp1` MCP tools will now be available — `search`, `get_symbol`, `get_neighbors`, `impact`, `recall_memory`, `list_projects`, etc.

This is all most people need. **Indexing** a project (adding it, or refreshing it after code changes) needs one more step below, since it requires reading source files off local disk.

---

## Indexing a project (only needed if you're adding/refreshing a project)

Search/recall work immediately after the setup above. Indexing is different: it reads your local checkout's source files and computes embeddings, then writes the results to the shared server — so it has to run somewhere that actually has those files on disk, i.e. **your machine**, not the remote server. Rather than a second MCP server, this is a plain script (`skills/cp1-index-project/scripts/index-project.sh`) — no MCP tool-calling involved.

Just ask Claude to index a project — the `cp1-index-project` skill handles it:

> "Index my-app at /path/to/my-app on branch main"

Claude will ask for your `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` (ask the admin) if it doesn't have them, then run:

```bash
SUPABASE_URL="<url>" SUPABASE_SERVICE_ROLE_KEY="<key>" \
  bash skills/cp1-index-project/scripts/index-project.sh \
  ~/mobile-agentic-toolkit /path/to/my-app my-app branch:main
```

The first run clones `mobile-agentic-toolkit` (default: `~/mobile-agentic-toolkit`) and runs `pnpm install` — no Docker, no local Supabase, since the database already runs on the team server. The embedding computation happens on your machine; only the results (symbols, edges, chunks, embeddings) get written to the shared database everyone's `search`/`recall` tools read from.

---

## Daily use

```
# Ask a question about any indexed codebase
"How does the payment flow work in my-app?"

# At the end of a session, save what you learned
/cp1-distill-session

# In a new session, recall what you already know
"What do we know about the payment flow?"
```

---

## Troubleshooting

**MCP tools return 401 / unauthorized**
→ `$CP1_AUTH_TOKEN` is unset or stale. Re-check step 2 of setup.

**MCP tools return a connection error**
→ The team server may be down, or your network is blocking outbound HTTPS. Ping the admin.

**Search returns nothing**
→ The project may not be indexed yet. Run `list_projects` to check, then see "Indexing a project" above.

**Indexing fails with a filesystem error**
→ Make sure you're using the `cp1-index-project` skill's script, not trying to call `index_project` as an MCP tool — the remote server can't see your local files at all.
