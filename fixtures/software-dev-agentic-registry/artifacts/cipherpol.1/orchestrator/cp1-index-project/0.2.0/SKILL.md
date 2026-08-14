---
name: cp1-index-project
description: Index or re-index a codebase into the shared cp1 knowledge base so it becomes searchable via the remote MCP server. Use when the user asks to index, re-index, or refresh a project in the knowledge base.
user-invocable: true
---

# Index a project into the shared knowledge base

`index_project` isn't callable on the remote `cp1` MCP server — it
needs to read source files off local disk, and the shared server (running in a
container on the team's VPS) can't see your machine's filesystem. Instead, use
the bundled script: it runs the exact same indexing pipeline locally and writes
the results straight into the shared database, with no MCP server involved at
all for this step.

## What you need

- **SUPABASE_URL** and **SUPABASE_SERVICE_ROLE_KEY** for the team's hosted
  instance — ask the admin if you don't have them. Never commit these.
- Nothing else — the script clones a local `mobile-agentic-toolkit` checkout
  itself if one doesn't already exist, and installs dependencies on first run.

## Steps

1. If you don't already have `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` from
   the user, ask for them.
2. Determine the project's `slug` (short identifier, e.g. `flex-mobile`) and
   `ref` (e.g. `branch:release/2.45`) — ask the user, or check the target
   repo's current branch (`git -C <path> branch --show-current`).
3. Run the script (defaults to cloning into `~/mobile-agentic-toolkit` if that
   path doesn't already exist — reuse an existing checkout if the user has one):
   ```bash
   SUPABASE_URL="<url>" SUPABASE_SERVICE_ROLE_KEY="<key>" \
     bash scripts/index-project.sh \
     ~/mobile-agentic-toolkit /path/to/project my-slug branch:main
   ```
   (`scripts/index-project.sh` is relative to this skill's directory.)
4. Report the summary table (files/symbols/edges/chunks/embeddings) back to
   the user.

## Notes

- Safe to re-run — indexing is content-hash gated, only changed symbols get
  re-embedded (`embeddedNew: 0` means nothing changed since last time).
- The embedding computation happens on **the machine running this script**;
  only the results (symbols, edges, chunks, embeddings) get written to the
  shared database that everyone's `search`/`recall` tools read from.
- First run against a fresh checkout is slower (clone + `pnpm install`).
