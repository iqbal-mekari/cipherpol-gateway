---
name: aegis-knowledge-lookup
description: Resolve free-text names (Figma component names, feature names) to cp-1 knowledge nodes via search_docs. One semantic search per name; returns resolved content + unresolved flags. Call once per batch.
user-invocable: false
allowed-tools: mcp__plugin_cipherpol-1_cp1__search_docs, mcp__cp1-dev__search_docs
---

Retrieval protocol (server selection, slug/ref/doc_type, fallback):
```bash
cat "$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md"
```

## Input

| Parameter | Required | Description |
|---|---|---|
| `names` | Yes | Comma-separated names to resolve — as they appear in the source (e.g. Figma component names, feature names) |
| `platform` | Yes | `flutter` \| `ios` \| `web` |
| `discipline` | Yes | `design` (→ `doc_type=design`) or `engineering` (→ `doc_type=standard`) |
| `slug` | No | cp-1 slug to search. Default `_global` for platform/design knowledge; a project slug for project-tier names. |

## Steps

### 1 — Resolve each name

For each name in `{names}`:

`search_docs(slug="{slug|_global}", query="{name}", platform=["{platform}"], doc_type=["{design|standard}"], k=3)`

Take the top result **only if** its heading breadcrumb, symbol name, or content plausibly matches the input name (e.g. `"primary button"` → `Mekari Pixel > Atoms > MpButton`). If plausible → record as `resolved` with the fetched content inline. If not → record as `unresolved`.

Prefer a single well-formed query per name. Only broaden the query (drop a suffix like `widget`/`view`/`component`, or raise `k`) when the first search returns nothing plausible.

## Output

```
## Knowledge Lookup Result

platform: {platform}
discipline: {discipline}
slug: {slug}
total: {N}
resolved: {N}
unresolved: {N}

### Resolved

#### {OriginalName} → {matched heading / symbol}
{full content of the matched node}

---

### Unresolved

- {OriginalName} — {reason}
```

Omit `### Unresolved` entirely if all names resolved. If `search_docs` is unavailable on both servers, return all names as unresolved with reason `cp-1 doc store unreachable`.
