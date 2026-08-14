# Developer Docs Sync Format

> Related: developer-docs-worker.md (writer)

Templates and derivation rules for the two artifact types `developer-docs-worker` writes to the project root: the feature doc (`docs/features/<feature-slug>.md`) and the ADR (`docs/architecture/NNNN-<slug>.md`). Both are full-regeneration writes — the worker recomputes content from `plan.md`/`context.md`/`state.json` on every run rather than diffing prior output; this is what keeps re-runs idempotent.

---

## Slug Derivation Rule <!-- 8 -->

`feature-slug` = the run directory's basename (e.g. `run_dir = .../runs/developer/time-tracking-export` → `feature-slug = time-tracking-export`), lowercased, with any character outside `[a-z0-9-]` replaced by `-` and repeated `-` collapsed to one. Run directory names are already kebab-case by convention, so this is normally a no-op.

The ADR slug reuses `feature-slug` — one plan.md maps to at most one feature doc and at most one ADR per run.

---

## ADR Numbering Rule <!-- 14 -->

Deterministic, no state file needed:

```bash
next=$(ls docs/architecture 2>/dev/null | grep -E '^[0-9]{4}-' | sort | tail -1 | cut -c1-4)
next=$((10#${next:-0} + 1))
printf '%04d\n' "$next"
```

Starts at `0001` when `docs/architecture/` is empty or missing. Never reuse a number, even if an earlier ADR was later removed — the scan is over what currently exists on disk at write time, computed fresh each run.

---

## Feature Doc Template <!-- 7 -->

Path: `docs/features/<feature-slug>.md`. Full heading set, fixed order — omit a section's rows if there is no data for it, but never omit the heading itself.

```markdown
# Feature: <feature name>

## Summary <!-- 3 -->
<1-3 sentences — what this feature does and why, drawn from plan.md frontmatter / context.md>

## Affected Layers <!-- 3 -->
- <Domain | Data | Presentation | App | UI — one per layer with a non-empty artifact table in plan.md>

## Key Artifacts <!-- 5 -->
| Artifact | Layer | Path | Status |
|---|---|---|---|
<one row per artifact across all plan.md layer tables — Path from context.md Key Symbols or plan.md Notes column when known, "-" otherwise>

## Links <!-- 4 -->
- Ticket: <ticket_key, or "none">
- Run: <run_dir>

## Last Synced <!-- 8 -->
<ISO 8601 timestamp of this write>
```

**Mode differences:** `mode: debug` runs typically have no `plan.md` (the debug flow's durable record is the investigation file, not a plan). When `plan.md` is absent, populate `## Summary` and `## Key Artifacts` from `context.md`/`state.json` only, and note under `## Summary` that this doc was generated without a plan.md source.

---

## ADR Template <!-- 7 -->

Path: `docs/architecture/NNNN-<slug>.md`. Written only when plan.md contains an architectural decision — see the detection rule in `developer-docs-worker.md`.

```markdown
# NNNN. <decision title>

## Status <!-- 3 -->
Accepted

## Context <!-- 3 -->
<why a decision was needed — the constraint, tradeoff, or deviation being addressed>

## Decision <!-- 3 -->
<what was decided — copied/summarized from plan.md's Decisions/Architecture section or deviation note>

## Consequences <!-- 5 -->
<what this decision implies going forward — follow-on work, constraints it imposes, what it rules out>
```

`Status` is always `Accepted` for docs-worker-generated ADRs — the decision already shipped by the time the docs worker runs post-build. `NNNN` in both the filename and the `# ` heading must match.
