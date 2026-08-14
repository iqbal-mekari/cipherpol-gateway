---
name: developer-data-create-mapper
description: Create a mapper that converts DTOs to domain entities and vice versa.
user-invocable: false
knowledge_scope: engineering
---

Create a Mapper following the {platform} standard architecture, loaded from the cp-1 doc store.

## Steps

1. **Load pattern** (see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`):
   - `search_docs(slug="_global", query="data mapper naming path convention code pattern", platform=["{platform}"], doc_type=["standard"])` — the Standard Architecture node for this artifact (breadcrumb `Standard Architecture > Data > Mapper`): naming, path convention, code pattern. Server selection + `cp1-dev` fallback: see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`.
   - If nothing relevant returns, STOP and report a knowledge gap for `{platform} standard-architecture / data / mapper` — do not guess.
2. **Confirm** both the DTO and domain entity exist before creating the mapper
3. **Locate** path per the impl doc's mapper directory convention
4. **Create** the mapper file following the impl doc pattern

## Rules

- Mapper contains only mapping logic — no business logic, no API calls
- Covers all fields — no silent field drops; use sensible defaults for optional → required mappings
- Bidirectional where needed (DTO → Entity and Entity → Payload)

## Output

Confirm file path and list all mapped fields with any non-trivial transformations noted.
