---
name: cp1-distill-session
description: Distill a coding session's raw log into durable, typed memories and store them in the knowledge base. Use at the end of a session, or when the user asks to "remember", "save what we learned", or "distill this session". Requires the cp1 MCP server.
user-invocable: true
---

# Distill session

You (the host) do the distillation — there is no server-side LLM. You read the raw
session log, decide what is durable, and store each memory. The MCP server only
provides the log and the storage.

## Inputs
- `slug` — the project slug in the knowledge base
- `session_id` — the session whose log to distill

If the user didn't give these, ask, or infer the session_id from the current session name.

## Procedure

1. **Fetch the raw log**: call `get_session_log({ slug, session_id })`.
   If it's empty, tell the user there's nothing to distill and stop.

2. **Extract durable memories.** Read the log and pull out only what stays true
   beyond this session. Discard transient chatter, tool noise, and one-off detail.
   Classify each into one `kind`:
   - `decision` — an architectural/design choice and its rationale
   - `fact` — a non-obvious truth about the codebase
   - `pattern` — a reusable approach/convention worth repeating
   - `gotcha` — a pitfall, sharp edge, or thing that bit us
   - `todo` — a concrete open follow-up

   Prefer a few high-signal memories over many weak ones. Each `content` must be a
   single self-contained statement understandable months later without the log.
   Set `confidence` in 0..1 (how durable/certain it is).

3. **Store each memory**: for every item, call
   `store_memory({ slug, session_id, memory: { kind, title, content, confidence } })`.

4. **Summarize** to the user: how many memories you stored, grouped by kind.

## Notes
- Don't store secrets, credentials, or large code blobs as memories.
- If two memories overlap, merge them into one before storing.
- Recall later with `recall_memory({ slug, query })`.
