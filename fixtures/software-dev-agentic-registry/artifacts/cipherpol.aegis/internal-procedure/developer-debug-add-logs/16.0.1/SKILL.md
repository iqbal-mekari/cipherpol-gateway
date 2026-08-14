---
name: developer-debug-add-logs
description: Add strategic debug logs to trace execution flow or diagnose a bug.
user-invocable: false
allowed-tools: Read, Edit, Glob, Grep, mcp__plugin_cipherpol-1_cp1__search_docs, mcp__cp1-dev__search_docs
knowledge_scope: engineering
---

Add debug instrumentation logs following the {platform} standard architecture (loaded from the cp-1 doc store) for format and prefix rules.

## Steps

Follow the `INSTRUMENTATION_BRIEF` provided by the caller:

1. **Load pattern** (see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md` for server selection + fallback). Logging lives under a platform-specific topic (flutter → `utilities`/`logger`; android → `presentation`/`logging`):
   - `search_docs(slug="_global", query="logger logging debug log format and prefix", platform=["{platform}"], doc_type=["standard"])` — the Standard Architecture logging node: log format and prefix.
   - If nothing relevant returns, STOP and report a knowledge gap for `{platform} standard-architecture / logging` — do not guess.
2. `Grep` each target method name to locate the exact line
3. `Read` only the method body — not the full file
4. Insert logs at entry, exit, branch points, and error handlers as specified in the brief

## Rules

- Log only at locations specified in the brief
- Never modify logic
- Never log passwords or tokens — log `.length` / `.count` instead
- Never commit debug logs

## Output

List each file and line where a log was inserted.
