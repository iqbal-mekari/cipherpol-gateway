---
name: aegis-codebase-explore
description: Execute one codebase search pass for a given symbol, pattern, or path. Encapsulates Grep-before-Read discipline. Call once per lookup target; call twice for two independent targets.
user-invocable: false
allowed-tools: Grep, Glob, Read
---

## Input

| Parameter | Required | Description |
|---|---|---|
| `target` | Yes | Symbol name, Grep pattern, or Glob path to search for |
| `type` | Yes | `symbol` \| `pattern` \| `exists` |
| `exclude` | No | Comma-separated paths to exclude from Grep. Default: `test/,mock/,fake/` |

## Steps

### exists

`Glob` for `{target}` → return found/not-found immediately. No Read.

### symbol

`Grep` for exact name `{target}`, excluding `{exclude}` paths.

Pick the best match: most method definitions, fewest TODO stubs.

`Read` best match at `(offset=line-10, limit=80)`.

### pattern

`Grep` for pattern `{target}`, excluding `{exclude}` paths.

Pick the most complete match (same heuristic as symbol).

`Read` most complete match at `(offset=line-10, limit=80)`.

## Output

Produce a `## Codebase Explore Result` block:

```
## Codebase Explore Result

- type: {symbol|pattern|exists}
- target: {target}
- matched_path: {absolute path or "not found"}
- excerpt:
  {code excerpt, or "—" if exists-check only}
```
