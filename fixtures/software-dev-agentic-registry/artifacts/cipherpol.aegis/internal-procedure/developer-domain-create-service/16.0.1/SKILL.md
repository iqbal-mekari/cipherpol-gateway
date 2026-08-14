---
name: developer-domain-create-service
description: Create a domain service for business logic that spans multiple entities or use cases.
user-invocable: false
knowledge_scope: engineering
---

Create a Domain Service following the {platform} standard architecture, loaded from the cp-1 doc store.

## Steps

1. **Load pattern** (see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`):
   - `search_docs(slug="_global", query="domain domain-service naming path convention code pattern", platform=["{platform}"], doc_type=["standard"])` — the Standard Architecture node for this artifact (breadcrumb `Standard Architecture > Domain > Domain Service`): naming, path convention, code pattern. Server selection + `cp1-dev` fallback: see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`.
   - If nothing relevant returns, STOP and report a knowledge gap for `{platform} standard-architecture / domain / domain-service` — do not guess.
2. **Confirm** this logic cannot live in a single entity or use case before creating a service
3. **Locate** path per the impl doc's service directory convention
4. **Create** the service file following the impl doc pattern

## Rules

- Domain service contains pure business logic — no infrastructure dependencies
- Stateless — no mutable fields
- Depends only on domain types — entities, value objects, domain errors

## Output

Confirm file path and list all public methods with signatures.
