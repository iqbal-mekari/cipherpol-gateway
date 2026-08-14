# Figma Artifact Format — Index

> Author: Puras Handharmahua · 2026-06-13

Overview of all Figma-derived artifacts produced by the validate → fetch → group pipeline. **Not read at runtime by agents** — agents read their specific format files below.

---

## Runtime Format Files

| Agent | Reads | Contains |
|---|---|---|
| `developer-figma-fetch-worker` | `figma-fetch-format.md` | `figma-<slug>.md` schema, `## Figma Worker Output` block |
| `developer-figma-group-worker` | `figma-group-format.md` | `figma-uistack-<screen-slug>.md` schema, `## Figma Groups` block |
| `developer-ui-worker` | `figma-fetch-format.md`, `figma-group-format.md` | Field contracts for both artifact types |

---

## `pending-frames.json` — Validated Frame Manifest

Written by `developer-figma-validate-worker`. Schema is inlined in that worker — no runtime reference file needed.

```json
[
  {
    "url": "https://www.figma.com/design/<fileKey>/file?node-id=<nodeId-with-dashes>",
    "fileKey": "<fileKey>",
    "nodeId": "<nodeId-with-colons>",
    "name": "<node name from Figma metadata>"
  }
]
```

---

## Section Contracts

| Artifact | Written by | Read by | Purpose |
|---|---|---|---|
| `pending-frames.json` | figma-validate-worker | fetch skill (Bash) | Validated flat frame list |
| `figma-<slug>.md` + screenshot | figma-fetch-worker | pres-planner, feature-worker, ui-worker | Per-frame semantic reference |
| `figma-uistack-<screen-slug>.md` | figma-group-worker | pres-planner, ui-worker | Merged per-screen component hierarchy, state model, interactions |
| `## Figma Validate Output` | figma-validate-worker | fetch skill | Directory path + frame count |
| `## Figma Worker Output` | figma-fetch-worker | fetch skill | Single-frame fetch result |
| `## Figma Groups` | figma-group-worker | fetch skill, feature-strategist | Screen clustering + uistack paths |
| `### Figma Alignment` table | pres-planner | feature-strategist | Maps artifacts to Figma files, states, interactions |
