---
name: developer-pres-create-stateholder
description: Create the StateHolder (BLoC / ViewModel / Presenter) for a feature screen.
user-invocable: false
knowledge_scope: engineering
---

Create the StateHolder following the {platform} standard architecture, loaded from the cp-1 doc store.

## Steps

1. **Load pattern** (see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`). The StateHolder topic is platform-specific (flutter → `state_management` with `bloc`/`cubit`; MVP platforms → `presentation` with `presenter`/`mvp_contract`):
   - `search_docs(slug="_global", query="state-holder state management bloc cubit presenter mvp contract naming path convention code pattern", platform=["{platform}"], doc_type=["standard"])` — the Standard Architecture node for this artifact (breadcrumb `Standard Architecture > State Management > State Holder`): naming, path convention, code pattern. Server selection + `cp1-dev` fallback: see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`.
   - If nothing relevant returns, STOP and report a knowledge gap for `{platform} standard-architecture / state-management / state-holder` — do not guess.
2. **Confirm** use cases exist in domain layer before proceeding
3. **Locate** path per `### Creation Order` in the impl doc
4. **Create** the StateHolder file(s) following the implementation pattern
5. **Produce** `.claude/agentic-state/developer/feature-plans/<feature>/stateholder-contract.md` per `### StateHolder Contract`

## Rules

- StateHolder never imports from the data layer — no DTOs, no `RepositoryImpl`, no `DataSource`
- Use cases injected via constructor — never instantiated inline
- Follows the platform's DI registration pattern (see impl doc)

## Output

Confirm file path(s), list all state fields, list all events/methods, and confirm stateholder-contract.md written.
