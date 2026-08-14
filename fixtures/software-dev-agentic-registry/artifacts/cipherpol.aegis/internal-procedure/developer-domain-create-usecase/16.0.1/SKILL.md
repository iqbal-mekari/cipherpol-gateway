---
name: developer-domain-create-usecase
description: Create a domain use case.
user-invocable: false
knowledge_scope: engineering
---

Create a Use Case following the {platform} standard architecture, loaded from the cp-1 doc store.

## Steps

1. **Load pattern** (see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`):
   - `search_docs(slug="_global", query="domain use-case naming path convention code pattern", platform=["{platform}"], doc_type=["standard"])` — the Standard Architecture node for this artifact (breadcrumb `Standard Architecture > Domain > Use Case`): naming, path convention, code pattern. Server selection + `cp1-dev` fallback: see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`.
   - If nothing relevant returns, STOP and report a knowledge gap for `{platform} standard-architecture / domain / use-case` — do not guess.
2. **Identify** the single business operation this use case performs
3. **Locate** path per the fetched doc's use case directory convention
4. **Create** the use case file following the fetched pattern

## Rules

- One use case per business operation — no multi-responsibility use cases
- Depends only on repository interfaces — never on concrete implementations
- Returns domain entities or errors — no DTOs, no UI types

## Output

Confirm file path, use case name, input params type, and return type.
