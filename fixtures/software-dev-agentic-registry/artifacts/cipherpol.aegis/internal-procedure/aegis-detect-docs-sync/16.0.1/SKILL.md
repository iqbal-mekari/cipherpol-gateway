---
name: aegis-detect-docs-sync
description: Detect the docs-sync configuration for the current session. Returns docs_sync=<auto|ask|off> and confluence_space=<key> for use by developer-docs-worker.
user-invocable: false
allowed-tools: Bash
---

Resolve the documentation-sync configuration. Both values come from the environment only — unlike `aegis-resolve-context` there is no manifest or codebase fallback, because neither value is derivable from the project.

## Detect docs_sync

```bash
echo "$CIPHERPOL_DOCS_SYNC"
```

| Env value | Result |
|---|---|
| `off` | `docs_sync=off` |
| `ask` | `docs_sync=ask` |
| `auto`, empty, unset, or anything else | `docs_sync=auto` |

Unrecognized values normalize to `auto` — never fail, never ask the user, never block the calling worker.

## Detect confluence_space

```bash
echo "$CIPHERPOL_CONFLUENCE_SPACE"
```

Non-empty → `confluence_space=<value>`. Empty or unset → `confluence_space=` (empty), meaning no Confluence mirroring.

## Output

Return exactly two lines, always both (`confluence_space` may be empty):

```
docs_sync=auto
confluence_space=ENG
```
