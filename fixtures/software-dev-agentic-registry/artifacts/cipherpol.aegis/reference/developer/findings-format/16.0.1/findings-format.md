# Findings Format

> Author: Puras Handharmahua · 2026-06-13
> Related: developer-domain-planner.md, developer-data-planner.md, developer-pres-planner.md, developer-app-planner.md

Shared input/output contract for the four layer planner agents — `developer-domain-planner`, `developer-data-planner`, `developer-pres-planner`, `developer-app-planner`. Each planner reads its inputs and writes its findings file per this contract; `developer-feature-convergence-strategist` (process-findings / synthesize modes) reads the `*-findings.md` files produced here.

---

## Input Contract

Required — return `MISSING INPUT: <param>` immediately if absent:

| Parameter | Description |
|---|---|
| `feature` | Feature name to search for |
| `platform` | `web`, `ios`, or `flutter` |
| `module-path` | Root path of the feature's module in the project |
| `run_dir` | Absolute path to the run directory — write findings here |
| `scope` | *(optional)* Comma-separated artifact types to search — layer-specific values |
| `open_questions` | *(optional, update path only)* List of specific issues or changes the user stated. Focus analysis on artifacts relevant to these questions. |
| `completed_artifacts` | *(optional, update path only)* Artifact names already built. Report these as `exists` + locked — do not propose recreating them. |

This is the shared base parameter set. `scope` values and any extra layer-specific input rows (e.g. `figma_groups` for the presentation planner) are documented in each planner's own `## Input` table.

---

## Search Protocol

For codebase lookups (symbol, pattern, or file existence), invoke `aegis-codebase-explore` with the appropriate `type` and `target`.

---

## Output Contract

Write findings to `<run_dir>/findings/<layer>-findings.md`, where `<layer>` is one of `domain`, `data`, `pres`, `app`:

```bash
mkdir -p "<run_dir>/findings"
```

### Impact Recommendations

Every findings file ends its body with an `### Impact Recommendations` table:

```markdown
### Impact Recommendations
| Layer | Reason | Urgency |
|---|---|---|
| <layer> | <reason> | required / optional |
```

Omit rows for layers with no impact. Omit the section entirely if no other layer is affected.

### Findings Written

After writing the file, return exactly:

```
## Findings Written
file: <run_dir>/findings/<layer>-findings.md
```
