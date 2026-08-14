---
name: developer-data-create-datasource
description: Create a data source (remote or local) in the data layer.
user-invocable: false
knowledge_scope: engineering
---

Create a DataSource following the {platform} standard architecture, loaded from the cp-1 doc store.

## Steps

1. **Load pattern** (see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`):
   - `search_docs(slug="_global", query="data data-source remote local naming path convention code pattern", platform=["{platform}"], doc_type=["standard"])` — the Standard Architecture node for this artifact (breadcrumb `Standard Architecture > Data > Data Source`): naming, path convention, code pattern. Include both remote and local data-source nodes if present. Server selection + `cp1-dev` fallback: see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`.
   - If nothing relevant returns, STOP and report a knowledge gap for `{platform} standard-architecture / data / data-source` — do not guess.
2. **Identify** whether this is a remote (API) or local (cache/DB) data source
3. **Locate** path per the impl doc's data source directory convention
4. **Create** the data source interface and implementation files following the impl doc pattern

## Rules

- DataSource depends on the platform's HTTP client or local storage — never on domain types directly
- Returns DTOs — never domain entities
- Error handling maps HTTP/storage errors to domain errors via the platform's error pattern

## Output

Confirm file path(s), list all methods with DTO return types, and confirm error mapping approach.
