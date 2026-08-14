# UIStack Align Format

> Author: Puras Handharmahua · 2026-06-15
> Related: developer-uistack-align-worker.md (writer); developer-ui-worker.md (reader); figma-artifact-format.md (`figma-uistack-<screen-slug>.md` schema)

Canonical annotation rules and output schemas for `developer-uistack-align-worker`. The worker reads this file before Step 5 to ensure annotations and table formats are applied exactly.

---

## Annotation Rules

### Component Hierarchy

Append inline on the same line as the component entry. Choose exactly one label:

| Condition | Annotation |
|---|---|
| Resolved from codebase (status: renamed) | _(none — no annotation)_ |
| Not found in design system or codebase (status: flagged) | `  ← ⚠ not found in design system` |

No additional prose, parentheticals, or "or codebase" text. The alignment table records the full resolution detail; the inline annotation is a terse flag only.

### Design Tokens

Append inline on the same line as the token entry:

| Condition | Annotation |
|---|---|
| Token resolved (ok or corrected) | _(none — no annotation)_ |
| Token not found anywhere (status: unknown) | `  ← ⚠ unknown` |

---

## `### Design System Alignment` Section

Appended at the end of `figma-uistack-<screen-slug>.md` by `developer-uistack-align-worker`.

```markdown
### Design System Alignment
> Revised by developer-uistack-align-worker

| Component | Original | Resolved | Source | Status |
|---|---|---|---|---|
| <name> | <original name from figma> | <resolved canonical name, or —> | design-system / codebase / — | ok / renamed / flagged |

| Token | Original | Resolved | Status |
|---|---|---|---|
| <name> | <original token from figma> | <resolved token name, or —> | ok / corrected / unknown |
```

Column semantics:

**Component table:**
- `Original` — name as it appeared in the uistack before alignment
- `Resolved` — canonical name after resolution; `—` if flagged
- `Source` — `design-system` (matched via cp-1), `codebase` (matched via Grep), `—` if flagged
- `Status` — `ok` (already canonical), `renamed` (corrected), `flagged` (not found)

**Token table:**
- `Original` — token as it appeared in the uistack before alignment (e.g. `--color/background/surface`)
- `Resolved` — corrected token name (e.g. `MpColors.bg.surface`); `—` if unknown
- `Status` — `ok` (already correct), `corrected` (renamed), `unknown` (not found)

Omit the `flagged:` rows from the component table when no components are flagged. Omit the token table entirely when no tokens are present in the uistack.

---

## `## UIStack Align Output` Block

Returned by `developer-uistack-align-worker` to its caller (`developer-fetch-figma`). No prose outside this block.

```
## UIStack Align Output
file: <abs path to revised uistack file>
ds_available: true | false
fallback_used: true | false
components_total: <N>
components_ok: <N>
components_renamed: <N>
components_flagged: <N>
tokens_total: <N>
tokens_ok: <N>
tokens_corrected: <N>
tokens_flagged: <N>
flagged:
  - name: <ComponentOrTokenName>
    type: component | token
    reason: not in design system or codebase
```

Omit `flagged:` key entirely if no items are flagged.

---

## Section Contracts

| Artifact | Written by | Read by | Purpose |
|---|---|---|---|
| `### Design System Alignment` | uistack-align-worker | ui-worker | Component/token resolution table for build reference |
| `← ⚠ not found in design system` inline | uistack-align-worker | ui-worker, pres-planner | Terse visual flag on unresolved components |
| `← ⚠ unknown` inline | uistack-align-worker | ui-worker | Terse visual flag on unresolved tokens |
| `## UIStack Align Output` | uistack-align-worker | developer-fetch-figma | Aggregated alignment stats and flagged items |
