---
name: developer-pres-create-component
description: Create a reusable presentational component that takes plain domain entities with no state-management awareness.
user-invocable: false
knowledge_scope: engineering
---

Create a presentational component following the {platform} standard architecture, loaded from the cp-1 doc store.

## Steps

1. **Load pattern** (see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`):
   - `search_docs(slug="_global", query="presentation component naming path convention code pattern", platform=["{platform}"], doc_type=["standard"])` — the Standard Architecture node for this artifact (breadcrumb `Standard Architecture > Presentation > Component`): naming, path convention, code pattern. Server selection + `cp1-dev` fallback: see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md`.
   - If nothing relevant returns, STOP and report a knowledge gap for `{platform} standard-architecture / presentation / component` — do not guess.
2. **Check** `## Shared Component Paths` for existing reusable components before creating a new one
3. **Identify** the entity or data type the component displays
4. **Locate** the path per the impl doc's component directory convention
5. **Create** the component file following the impl doc pattern

## Rules

- Component is state-management-unaware — receives only plain entity data via constructor/props
- No state manager bindings inside a component
- Use immutable/const constructor — all fields final/readonly

## Output

Confirm file path and list all constructor parameters / props.
