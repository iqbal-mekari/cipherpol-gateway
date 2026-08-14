---
name: developer-domain-create-repository
description: Create a domain repository interface.
user-invocable: false
knowledge_scope: engineering
---

Create a Repository interface following the {platform} standard architecture, loaded from the cp-1 doc store.

## Steps

1. **Load pattern** (see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`):
   - `search_docs(slug="_global", query="domain repository-interface naming path convention code pattern", platform=["{platform}"], doc_type=["standard"])` — the Standard Architecture node for this artifact (breadcrumb `Standard Architecture > Domain > Repository Interface`): naming, path convention, code pattern. Server selection + `cp1-dev` fallback: see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`.
   - If nothing relevant returns, STOP and report a knowledge gap for `{platform} standard-architecture / domain / repository-interface` — do not guess.
2. **Identify** the data operations the feature needs
3. **Locate** path per the impl doc's repository interface convention
4. **Create** the interface file following the impl doc pattern

## Rules

- Interface lives in the domain layer — no data layer imports
- Methods return domain entities or primitives — no DTOs, no DB types
- Error handling follows the platform's domain error pattern (see impl doc)

## Output

Confirm file path and list all interface methods with return types.
