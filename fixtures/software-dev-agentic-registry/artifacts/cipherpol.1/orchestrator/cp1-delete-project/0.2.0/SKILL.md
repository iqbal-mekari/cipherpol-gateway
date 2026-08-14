---
name: cp1-delete-project
description: Delete a project (or a single ref/snapshot) from the shared cp1 knowledge base. Use when the user asks to delete, remove, or clean up a project or snapshot from the knowledge base.
user-invocable: true
---

# Delete a project from the shared knowledge base

`delete_project` isn't callable on the remote MCP server — like indexing,
deleting is treated as an admin-level operation requiring the actual
Supabase service-role key directly, not just the shared MCP bearer token.
Use the bundled script instead.

## What you need

- **SUPABASE_URL** and **SUPABASE_SERVICE_ROLE_KEY** — ask the admin.
- Always preview first (omit `--confirm`) and show the user exactly what
  will be deleted before re-running with `--confirm`. Whole-project
  deletion is irreversible.

## Steps

1. Ask for `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` if not already provided.
2. Run **without** `--confirm` first to preview:
   ```bash
   SUPABASE_URL="<url>" SUPABASE_SERVICE_ROLE_KEY="<key>" \
     bash scripts/delete-project.sh ~/mobile-agentic-toolkit my-slug [branch:main]
   ```
   (`scripts/delete-project.sh` is relative to this skill's directory.)
3. Show the user the preview output and get explicit confirmation before continuing.
4. Re-run with `--confirm` appended to actually delete:
   ```bash
   SUPABASE_URL="<url>" SUPABASE_SERVICE_ROLE_KEY="<key>" \
     bash scripts/delete-project.sh ~/mobile-agentic-toolkit my-slug [branch:main] --confirm
   ```

## Notes

- Omit the ref argument to delete the **entire project** (all refs,
  memories, skills, and the on-disk folder) — cannot be undone.
- Pass a ref (e.g. `branch:main`) to delete only that snapshot —
  memories/skills are untouched.
- Never skip the preview step, even if the user seems certain.
