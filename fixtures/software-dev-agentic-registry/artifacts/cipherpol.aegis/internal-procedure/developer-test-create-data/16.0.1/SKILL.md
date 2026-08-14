---
name: developer-test-create-data
description: Create unit tests for repository implementations and mappers.
user-invocable: false
knowledge_scope: engineering
---

Create data layer tests following the {platform} standard architecture, loaded from the cp-1 doc store.

## Steps

1. **Load pattern** (see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`):
   - `search_docs(slug="_global", query="testing repository-test naming path convention code pattern", platform=["{platform}"], doc_type=["standard"])` — the Standard Architecture node for this artifact (breadcrumb `Standard Architecture > Testing > Repository Test`): naming, path convention, code pattern. Server selection + `cp1-dev` fallback: see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`.
   - If nothing relevant returns, STOP and report a knowledge gap for `{platform} standard-architecture / testing / repository-test` — do not guess.
2. **Grep** for the repository impl and mapper class names → get line numbers → **Read** `offset=<line-5> limit=60` around each to capture method signatures and mapping logic
3. **Identify** all code paths: data source success, data source error, mapping edge cases
4. **Locate** path per the impl doc's test directory convention
5. **Create** test file(s) following the impl doc pattern

## Rules

- Mock the data source — never make real network calls in unit tests
- Mapper tests use static fixtures — no mocks needed
- Verify DTO → entity mapping covers all fields

## Output

Confirm file path(s) and list all test cases by name.
