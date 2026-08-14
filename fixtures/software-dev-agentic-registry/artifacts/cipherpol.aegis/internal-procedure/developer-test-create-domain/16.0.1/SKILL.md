---
name: developer-test-create-domain
description: Create unit tests for domain use cases and services.
user-invocable: false
knowledge_scope: engineering
---

Create domain tests following the {platform} standard architecture, loaded from the cp-1 doc store.

## Steps

1. **Load pattern** (see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`):
   - `search_docs(slug="_global", query="testing use-case-test naming path convention code pattern", platform=["{platform}"], doc_type=["standard"])` — the Standard Architecture node for this artifact (breadcrumb `Standard Architecture > Testing > Use Case Test`): naming, path convention, code pattern. Server selection + `cp1-dev` fallback: see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`.
   - If nothing relevant returns, STOP and report a knowledge gap for `{platform} standard-architecture / testing / use-case-test` — do not guess.
2. **Grep** for the use case / service class name → get line number → **Read** `offset=<line-5> limit=60` to capture the method signature and primary logic
3. **Identify** all code paths and edge cases to cover
4. **Locate** path per the impl doc's test directory convention
5. **Create** the test file following the impl doc pattern

## Rules

- Use mocks for all dependencies — never hit real repositories or APIs in unit tests
- Test each handler/method independently
- Cover success, error, and edge cases

## Output

Confirm file path and list all test cases by name.
