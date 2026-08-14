---
name: developer-debug-remove-logs
description: Remove all debug logs added by developer-debug-add-logs.
user-invocable: false
allowed-tools: Read, Edit, Glob, Grep, mcp__plugin_cipherpol-1_cp1__search_docs, mcp__cp1-dev__search_docs
knowledge_scope: engineering
---

Remove all debug instrumentation logs using the platform's log prefix, loaded from the cp-1 doc store.

## Steps

1. **Load pattern** (see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md` for server selection + fallback). Logging lives under a platform-specific topic (flutter → `utilities`/`logger`; android → `presentation`/`logging`):
   - `search_docs(slug="_global", query="logger logging debug log format and prefix", platform=["{platform}"], doc_type=["standard"])` — the Standard Architecture logging node: the debug log prefix (e.g. `[DebugTest]`).
   - If nothing relevant returns, STOP and report a knowledge gap for `{platform} standard-architecture / logging` — do not guess.
2. `Grep` the codebase for the debug prefix to find all instrumented files
3. For each file: `Read` the file, then `Edit` to remove every debug log line
4. Confirm no debug logs remain

## Rules

- Remove only debug log lines — never touch other logic
- Verify removal with a final grep for the prefix

## Output

List each file where logs were removed and confirm final grep shows zero matches.
