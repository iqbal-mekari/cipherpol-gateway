---
name: developer-test-create-presentation
description: Create unit tests for the StateHolder (BLoC / ViewModel / Presenter).
user-invocable: false
knowledge_scope: engineering
---

Create presentation tests following the {platform} standard architecture, loaded from the cp-1 doc store.

## Steps

1. **Load pattern** (see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`):
   - `search_docs(slug="_global", query="testing presenter-test stateholder naming path convention code pattern", platform=["{platform}"], doc_type=["standard"])` — the Standard Architecture node for this artifact (breadcrumb `Standard Architecture > Testing > Presenter Test`): naming, path convention, code pattern. Server selection + `cp1-dev` fallback: see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`.
   - If nothing relevant returns, STOP and report a knowledge gap for `{platform} standard-architecture / testing / presenter-test` — do not guess.
2. **Grep** for the StateHolder class name → get line number → **Read** `offset=<line-5> limit=80` to capture state fields, event/action cases, and constructor params. **Read** stateholder-contract.md completely
3. **Identify** all events/methods and resulting state transitions to cover
4. **Locate** path per the impl doc's test directory convention
5. **Create** the test file following the impl doc pattern

## Rules

- Mock all use cases — StateHolder tests are pure unit tests
- Test each event/method independently: verify state transitions and emitted actions
- Cover success, error, loading, and edge cases

## Output

Confirm file path and list all test cases by name.
