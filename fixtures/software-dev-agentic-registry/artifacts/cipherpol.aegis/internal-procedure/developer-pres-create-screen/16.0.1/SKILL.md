---
name: developer-pres-create-screen
description: Create the Screen / View that binds to the StateHolder and renders state.
user-invocable: false
knowledge_scope: engineering
---

Create a Screen following the {platform} standard architecture, loaded from the cp-1 doc store.

## Steps

1. **Read** `.claude/agentic-state/developer/feature-plans/<feature>/stateholder-contract.md` completely — must match state fields and events exactly
2. **Load pattern** (see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`):
   - `search_docs(slug="_global", query="presentation screen naming path convention code pattern", platform=["{platform}"], doc_type=["standard"])` — the Standard Architecture node for this artifact (breadcrumb `Standard Architecture > Presentation > Screen`): naming, path convention, code pattern. Server selection + `cp1-dev` fallback: see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`.
   - If nothing relevant returns, STOP and report a knowledge gap for `{platform} standard-architecture / presentation / screen` — do not guess.
3. **Locate** path per the impl doc's screen directory convention
4. **Create** the screen file following the impl doc pattern
5. **Register** route/navigation entry if required by the platform (see impl doc)

## Rules

- Screen is state-management-aware only as a consumer — it reads state and dispatches events; it never contains business logic
- Navigation side effects belong in the listener/observer pattern (see impl doc), not inline in render methods
- All state fields and event types must match the stateholder-contract exactly

## Output

Confirm file path, list all handled state cases, list all dispatched events, and confirm route registration if applicable.
