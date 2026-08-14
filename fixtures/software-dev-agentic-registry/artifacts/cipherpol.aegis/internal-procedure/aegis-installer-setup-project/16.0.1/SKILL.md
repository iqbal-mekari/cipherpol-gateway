---
name: aegis-installer-setup-project
description: Set up the project environment following the project's setup knowledge in the cp-1 doc store.
user-invocable: false
allowed-tools: mcp__plugin_cipherpol-1_cp1__search_docs, mcp__cp1-dev__search_docs
---

Set up the project following its setup knowledge in the cp-1 doc store. Retrieval
protocol (server selection, slug/doc_type scoping, fallback):

```bash
cat "$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md"
```

## Input

| Parameter | Required | Description |
|---|---|---|
| `cp1_slug` | Yes | The project's cp-1 slug, from the Working Context. Empty → no project knowledge; report and stop. |

## Steps

1. **Retrieve** — `search_docs(slug="{cp1_slug}", query="project setup environment prerequisites install", doc_type=["reference","standard"])`
2. Execute each setup step in the order the returned content specifies
3. Verify the setup succeeded per its verification section (if present)

Soft-fail — if cp-1 is unavailable on both servers, or the search returns nothing,
report `setup: skipped (no project setup knowledge)` rather than guessing at steps.

## Output

Confirm each setup step completed and note any that required manual intervention.
