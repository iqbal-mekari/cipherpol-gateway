---
name: developer-domain-create-entity
description: Create a domain entity class.
user-invocable: false
knowledge_scope: engineering
---

Create a domain Entity following the {platform} standard architecture, loaded from the cp-1 doc store.

## Steps

1. **Load pattern** (see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`):
   - `search_docs(slug="_global", query="domain entity naming path convention code pattern", platform=["{platform}"], doc_type=["standard"])` — the Standard Architecture node for this artifact (breadcrumb `Standard Architecture > Domain > Entity`): naming, path convention, code pattern. Server selection + `cp1-dev` fallback: see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`.
   - If nothing relevant returns, STOP and report a knowledge gap for `{platform} standard-architecture / domain / entity` — do not guess.
2. **Identify** the business concept the entity represents
3. **Locate** path per the impl doc's entity directory convention
4. **Create** the entity file following the impl doc pattern

## Rules

- Entity contains only domain fields and business identity — no persistence annotations, no UI types
- Immutable by default — use value equality

## Output

Confirm file path and list all fields.
