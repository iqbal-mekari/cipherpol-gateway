---
name: developer-data-create-repository-impl
description: Create the repository implementation that bridges domain interfaces and data sources.
user-invocable: false
knowledge_scope: engineering
---

Create a Repository Implementation following the {platform} standard architecture, loaded from the cp-1 doc store.

## Steps

1. **Load pattern** (see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`):
   - `search_docs(slug="_global", query="data repository-implementation naming path convention code pattern", platform=["{platform}"], doc_type=["standard"])` — the Standard Architecture node for this artifact (breadcrumb `Standard Architecture > Data > Repository Implementation`): naming, path convention, code pattern. Server selection + `cp1-dev` fallback: see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`.
   - If nothing relevant returns, STOP and report a knowledge gap for `{platform} standard-architecture / data / repository-implementation` — do not guess.
2. **Confirm** the domain repository interface, data source, and mapper all exist
3. **Locate** path per the impl doc's repository impl directory convention
4. **Create** the repository implementation file following the impl doc pattern
5. **Register** in DI if required by the platform

## Rules

- Implements the domain repository interface — every method must match exactly
- Calls data source, then maps DTO → entity via mapper — never maps inline
- Error handling converts data layer exceptions to domain errors

## Output

Confirm file path, confirm all interface methods are implemented, and confirm DI registration if applicable.
