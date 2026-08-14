# Figma Fetch Format

> Related: developer-figma-fetch-worker.md (writer); developer-ui-worker.md (reader)

Schema for per-frame artifacts written by `developer-figma-fetch-worker` and the worker output block returned to the orchestrating skill.

---

## `figma-<slug>.md` — Semantic Reference

One file per fetched Figma node/frame.

```markdown
---
source: <figma_url>
parent_frame: <parent frame or component set name>
state: <state name this node represents>
screenshot: <figma_fetch_dir>/frame_<sanitized_node_id>/figma-<slug>-screenshot.png
layout_source: <figma_url>
---

## <NodeName>
**State:** <state this frame represents — e.g. empty, loading, content, error>
**Interactions:** <key interactions derived from event handlers, or "none">
**Tokens:** <key design token variables used — e.g. --color/primary, --spacing/md>
**Annotations:** <visible text labels, aria labels, designer notes>

**Component Hierarchy:**
```
<RootComponent> [<ui-role>: <variant>]
  ├── <ChildComponent> [<ui-role>: <variant>]
  │     └── <GrandchildComponent> [<ui-role>: <variant>]
  └── <ChildComponent> [<ui-role>: <variant>]
```
```

### Companion Files

Both files live together under `<figma_fetch_dir>/frame_<sanitized_node_id>/`:

- `figma-<slug>-screenshot.png` — downloaded screenshot. If the download fails, a `.png.failed` placeholder is written instead and `screenshot: null` is recorded in frontmatter
- JSX is not written to disk — `layout_source` in frontmatter is the Figma URL; ui-worker calls `get_design_context` on demand

### Field Contracts

| Field | Read by | Purpose |
|---|---|---|
| `parent_frame`, `state` (frontmatter) | pres-planner | Screen grouping, `### Figma Alignment` table |
| `State`, `Interactions` (body) | pres-planner, feature-worker, ui-worker | StateHolder state field / event case derivation |
| `Component Hierarchy`, `Annotations` (body) | pres-planner, ui-worker | Layout transcript, UI element naming — hierarchy is pre-built from JSX at fetch time |
| `layout_source` (frontmatter) | ui-worker only | Figma URL to re-fetch JSX on demand via `get_design_context` |
| `screenshot` (frontmatter path) | ui-worker only | Visual reference for Screen/Component creation |
| `Tokens` (body) | ui-worker | Design token mapping during UI build |

`feature-worker` reads the `.md` body only (`State`, `Interactions`) — never `Component Hierarchy`, `layout_source`, or `screenshot`; those are the UI worker's concern.

---

## `## Figma Worker Output` Block

Returned by `developer-figma-fetch-worker` to its caller after a successful single-frame fetch:

```
## Figma Worker Output
source: <figma_url>
file: <figma_fetch_dir>/frame_<sanitized_node_id>/figma-<slug>.md
layout_source: <figma_url>
screenshot: <figma_fetch_dir>/frame_<sanitized_node_id>/figma-<slug>-screenshot.png
parent_frame: <parent frame or component set name>
state: <state name this node represents>
components: <comma-separated list of notable component names>
notes: <1–2 sentences on design-level observations relevant to implementation>
```
