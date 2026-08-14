---
name: developer-test-create-mock
description: Generate mock classes for domain interfaces used in tests.
user-invocable: false
knowledge_scope: engineering
---

Create mocks following the {platform} standard architecture, loaded from the cp-1 doc store.

## Steps

1. **Load pattern** (see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`):
   - `search_docs(slug="_global", query="testing mock-generation naming path convention codegen vs manual code pattern", platform=["{platform}"], doc_type=["standard"])` — the Standard Architecture node for this artifact (breadcrumb `Standard Architecture > Testing > Mock Generation`): naming, path convention, codegen vs manual approach. Server selection + `cp1-dev` fallback: see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`.
   - If nothing relevant returns, STOP and report a knowledge gap for `{platform} standard-architecture / testing / mock-generation` — do not guess.
2. **Identify** the interfaces that need mocking (repository, use case, service)
3. **Locate** path per the impl doc's mock directory convention
4. **Create** or generate the mock file(s) following the impl doc pattern

## Rules

- Mocks implement the domain interface — never mock concrete classes
- Follow the platform's mock generation approach (codegen vs manual per impl doc)

## Output

Confirm file path(s) and list all mocked interfaces.
