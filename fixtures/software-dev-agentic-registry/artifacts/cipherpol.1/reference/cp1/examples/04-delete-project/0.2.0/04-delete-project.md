# Example: Delete a project

> Uses the `cp1-delete-project` skill's script — not an MCP tool call. Deleting,
> like indexing, requires the actual Supabase service-role key, not just the
> shared MCP bearer token.

**User:** Delete the old-prototype project from the knowledge base

**Claude uses (preview first, no `--confirm`):**
```bash
SUPABASE_URL="<url>" SUPABASE_SERVICE_ROLE_KEY="<key>" \
  bash skills/cp1-delete-project/scripts/delete-project.sh \
  ~/mobile-agentic-toolkit old-prototype
```

**Claude shows the preview to the user and asks for confirmation, then re-runs with `--confirm`:**
```bash
SUPABASE_URL="<url>" SUPABASE_SERVICE_ROLE_KEY="<key>" \
  bash skills/cp1-delete-project/scripts/delete-project.sh \
  ~/mobile-agentic-toolkit old-prototype --confirm
```

**Tips:**
- Omit the ref to delete the entire project (all refs, memories, skills, on-disk folder) — irreversible.
- Pass a ref (e.g. `branch:main`) as the third argument to delete only that snapshot.
- Never skip the preview step, even if the user says they're sure.
