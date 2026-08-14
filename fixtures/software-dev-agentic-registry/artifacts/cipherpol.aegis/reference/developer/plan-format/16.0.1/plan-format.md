# Feature Plan Document Format

> Author: Puras Handharmahua · 2026-06-13
> Related: developer-feature-convergence-strategist.md (writer), developer-feature-worker.md, developer-ui-worker.md (readers)

Single source of truth for the `plan.md` / `context.md` schema used by the developer-plan-build-feature flow — written by `developer-feature-convergence-strategist` (synthesize mode), consumed by `developer-feature-worker` and `developer-ui-worker`.

## Living Document Rules

- **Never replace** — `plan.md` and `context.md` are extended in-place, never rewritten from scratch. Git is the version history; no `plan-v*.md` archiving.
- **Steps are permanent** — done steps stay visible in `## Steps` with `status: done`. Steps are never removed; new steps are appended, continuing the existing ID sequence. This preserves full history and supports resume after feedback cycles.
- **Layer tables are reference, not progress** — artifact rows are never removed. New artifacts from re-evaluate are appended. The `## Steps` section is the single source of truth for execution progress.
- **Re-evaluate appends** — when intent changes (e.g. bug feedback), the strategist appends new artifact rows to the relevant layer tables and new step rows to `## Steps`, continuing both sequences. New batches are added to frontmatter continuing the id sequence.
- **`context.md` grows** — new key symbols are appended to existing sections; existing rows are only updated if a path or signature changed.
- **No history headers** — do not write `> Update round N` or similar commentary in plan.md. Round progression is captured by git history, not inline headers.

---

## plan.md Schema

```markdown
---
feature: <name>
status: pending
operations: [get-list, get-single, post, put, delete]
separate-ui-layer: true | false
batches:
  - { id: 1, layer: domain, label: Domain Layer, steps: [1, 2, 3], status: pending }
  - { id: 2, layer: data,   label: Data Layer,   steps: [4, 5, 6], status: pending }
  - { id: 3, layer: pres,   label: Pres Layer,   steps: [7, 8, 9], status: pending }
  - { id: 4, layer: app,    label: App Layer,     steps: [10, 11],  status: pending }
  - { id: 5, layer: ui,     label: UI Layer,      steps: [12, 13],  status: pending }
---

# Feature Plan: <name>

## Domain Layer
| Artifact | Type | Status | Notes |
|---|---|---|---|

## Data Layer
| Artifact | Type | Status | Notes |
|---|---|---|---|

## Presentation Layer
| Artifact | Type | Status | Notes |
|---|---|---|---|

## UI Layer
| Artifact | Type | Status | Notes |
|---|---|---|---|

## App Layer
| Concern | File | Action | Notes |
|---|---|---|---|

## Steps
| Step | Artifact | Layer | Status |
|---|---|---|---|

## Skipped Layers
<list any layers skipped and why>

## Risks and Notes
<anything the engineer should review before approving>
```

**Steps section:** Steps are globally numbered, sequential across all layers. Each step maps to one artifact. Status values: `pending` → `in-progress` → `done`. Done steps stay visible — never removed. New steps (from re-evaluate cycles) are appended, continuing the sequence.

**Layer table `Status` column:** Artifact disposition — `create`, `exists`, or `patch`. Not execution progress (that's in Steps).

**Notes column:** One line maximum. For `create` artifacts: the key implementation constraint (pattern to follow, field shape, non-obvious behavior). For `patch`/`exists` artifacts: the target file path (module-relative) and exactly what to add or change. Never repeat information already in the Type column or derivable from layer contracts.

---

### plan.md Section Contracts

| Section | Required | Written by | Read by | Purpose |
|---|---|---|---|---|
| frontmatter (`feature`/`status`/`operations`/`separate-ui-layer`) | always | feature-strategist | feature-worker, ui-worker | Run-level metadata — drives layer selection and resume checkpoints |
| frontmatter `batches` | always | feature-strategist | developer-plan-build-feature skill | Ordered execution plan — each batch groups step IDs for one worker call; `status` updated live; re-evaluate appends new batches continuing the id sequence; completed batches remain permanently |
| `## Domain Layer` table | always | feature-strategist | feature-worker | Artifact reference — rows never removed; new artifacts appended on re-evaluate |
| `## Data Layer` table | always | feature-strategist | feature-worker | Artifact reference — rows never removed; new artifacts appended on re-evaluate |
| `## Presentation Layer` table | always | feature-strategist | feature-worker | Artifact reference — rows never removed; new artifacts appended on re-evaluate |
| `## UI Layer` table | always | feature-strategist | ui-worker | Artifact reference — rows never removed; new artifacts appended on re-evaluate |
| `## App Layer` table | always | feature-strategist | feature-worker | Concern reference — rows never removed; new concerns appended on re-evaluate |
| `## Steps` table | always | feature-strategist | feature-worker, ui-worker, user | Execution sequence and progress — globally numbered; done steps stay visible; new steps appended on re-evaluate |
| `## Skipped Layers` | always | feature-strategist | user | Explains layers omitted from the plan, surfaced during approval |
| `## Risks and Notes` | always | feature-strategist | user | Surfaces review items the engineer should consider before approving |

---

## context.md Schema

```markdown
---
feature: <name>
platform: <platform>
module-path: <detected module path>
raw_docs:
  - { path: <abs path>, description: <first heading or filename> }
---

## Figma Alignment
(omit this section entirely if no `### Figma Alignment` table was found in planner findings)

Referenced `Figma Files` (`figma-*.md`) and `UI Stack` (`figma-uistack-*.md`) follow the schema in `figma-artifact-format.md`.

| Screen (parent_frame) | Artifact | UI Stack | Figma Files | States | Key Interactions |
|---|---|---|---|---|---|
<rows copied verbatim from pres-planner's ### Figma Alignment table>

## Key Symbols
(omit entirely for new-only features)

### <FileName> (<artifact type>)
- constructor_params: <param>: <Type>, ...
- execute_signature / primary_method_signature: ...
```

**What belongs in context.md:**
- `## Key Symbols` — constructor signatures, method signatures, and field shapes for existing artifacts that workers call into. One entry per artifact that has `status: exists` or `status: patch` in plan.md. Omit for net-new artifacts.
- `## Figma Alignment` — maps screen/component artifacts to their UI Stack file and source Figma frames. Required when the pres planner found Figma data.

**What does not belong in context.md:**
- Naming conventions — loaded by workers from cp-1 via `aegis-knowledge-load`
- Discovered artifact inventories — the plan.md `Status` column (`create`/`exists`/`patch`) drives new-vs-exists routing

---

### context.md Section Contracts

| Section | Required | Written by | Read by | Purpose |
|---|---|---|---|---|
| frontmatter (`feature`/`platform`/`module-path`) | always | feature-strategist | feature-worker, ui-worker | Run-level metadata — derives `project`/`platform` for convention lookups |
| frontmatter `raw_docs` | always (empty list if none) | feature-strategist | plan-feature skill (resume path) | Source documents that informed the plan — restored on resume to re-pass to planners |
| `## Figma Alignment` | conditional — only if pres-planner findings included a `### Figma Alignment` table | feature-strategist | ui-worker (also referenced by feature-worker for StateHolder state/interaction shape) | Maps screens/artifacts to their merged UI Stack file, source Figma files, states, and key interactions |
| `## Key Symbols` | conditional — omit for new-only features | feature-strategist | feature-worker, ui-worker | Existing signatures (constructor params, method signatures) for targeted edits to existing artifacts |
