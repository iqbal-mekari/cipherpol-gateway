# Developer Debug Report-TS Format

> Author: Aflah Taqiu Sondha · 2026-06-25
> Related: developer-debug-report-ts/SKILL.md, developer-debug-ts-classify-worker.md, developer-debug-ts-firebase-worker.md, developer-debug-ts-log-analyzer-worker.md, developer-debug-ts-fix-worker.md

Output contract for the run report written to `.claude/agentic-state/runs/developer/debug-report-ts/<timestamp>-<slug>/report.md` by the `developer-debug-report-ts` skill. The report is created at Step 0 and each section is appended by the skill as its corresponding step completes.

---

## File Naming

```
.claude/agentic-state/runs/developer/debug-report-ts/<YYYYMMDD-HHmmss>-ts-report/report.md
```

- `YYYYMMDD-HHmmss` — timestamp when the run started (from Step 0 Bash call)
- Slug is always `ts-report` — the skill appends a user-readable slug to the directory only if one is derived later

The run directory also contains:
- `loki-raw.json` — raw output from `developer-debug-ts-loki-query-worker` (written by the skill at Step 4)

---

## Report Structure

Sections appear in this order. Each section is appended by the orchestrator skill using `Bash` after the relevant step completes. Sections are never rewritten — only appended.

---

### `## Issue Spec`

Written by: `developer-debug-report-ts` skill (Step 1, after intake)

Contains:
- `Report:` — the raw issue description or bug report from the user
- `Repo:` — one of `mobile-talenta`, `talenta-mobile-android`, `talenta-ios`
- `Screen hint:` — the screen or feature area reported by the user
- `Date range:` — the date window provided, or `"not provided"`
- `OS version:` — the OS version provided, or `"not provided"`
- `Talenta version:` — the app version provided, or `"not provided"`
- `User ID:` — custom key target, or `"not provided"`
- `User email:` — custom key target, or `"not provided"`
- `Company ID:` — custom key target, or `"not provided"`

---

### `## Classification`

Written by: `developer-debug-report-ts` skill (Step 2, after spawning `developer-debug-ts-classify-worker` in `classify` mode)

Contains the verbatim `Classification:` block from the worker, which includes:
- `type:` — `api | anr | crash | other`
- `evidence:` — one sentence supporting the classification
- `implicated_area:` — files, screen, endpoint, and layer

---

### `## Firebase Findings`

Written by: `developer-debug-report-ts` skill (Step 3, after spawning `developer-debug-ts-firebase-worker`)

Contains the full structured findings block from the worker:
- Query summary (app, project, error types, date range, filters applied)
- Matched issues ranked by relevance, each with: issue ID, title, subtitle, description, error type, affected versions/OS, custom-key match evidence

Omitted from the report if the data guard in Step 2 fired (no data properties provided by the user).

---

### `## Loki Findings`

Written by: `developer-debug-report-ts` skill (Step 4, after spawning `developer-debug-ts-log-analyzer-worker`)

Contains the full Log Analysis Report from `developer-debug-ts-log-analyzer-worker`, which includes:
- Generated timestamp and summary counts
- Session timelines (chronological event log per `trace_id`)
- Errors found table
- Root cause analysis per error
- Proposed code fixes (when `PROJECT_PATH` was available)

Omitted from the report if classification was `anr` or `crash`, or if the data guard fired.

---

### `## Code Analysis`

Written by: `developer-debug-report-ts` skill (Step 5, from `developer-debug-ts-classify-worker` `analyze-root-cause` mode output)

Contains the call chain trace — each layer touched during root cause tracing, with file paths and method names.

---

### `## Root Cause`

Written by: `developer-debug-report-ts` skill (Step 5, from `developer-debug-ts-classify-worker` `analyze-root-cause` mode output)

Contains:
- One clear root cause sentence (or `"Inconclusive — dynamic evidence unavailable"`)
- `Root cause layer:` — Presentation, Domain, Data, DI, or unknown
- `Confidence:` — high, medium, or low

---

### `## Proposed Solutions`

Written by: `developer-debug-report-ts` skill (Step 5, from `developer-debug-ts-classify-worker` `analyze-root-cause` mode output)

Contains 2–3 proposed solutions, each with:
- Title
- Description (what to change)
- Files (implicated paths)
- Tradeoffs (pros and cons)

---

### `## Chosen Solution`

Written by: `developer-debug-report-ts` skill (Step 6, after the user chooses via `AskUserQuestion`)

Contains:
- The user's chosen solution title and description
- Or `"None — report only"` if the user declined implementation

---

### `## Implementation`

Written by: `developer-debug-report-ts` skill (Step 7, from `developer-debug-ts-fix-worker` output)

Contains either:

**Localized fix path:**
- Fix title and scope label (`localized`)
- List of modified files with one-line change descriptions
- Validation results (Glob + Grep checks per file)
- Next steps (reproduce, remove instrumentation if added)

**Handoff path (multi-layer fix):**
- Reason the fix exceeded localized scope
- The ready-to-use `/developer-build-feature` plan block

Omitted from the report if the user chose "None" in Step 6.

---

## Rules

- Create the report file at Step 0 with a `# TS Issue Report` heading and `Started:` timestamp.
- Append each section using `Bash` — never overwrite existing content.
- If a step is skipped (data guard, classification gate, or user choice), omit that section rather than writing a placeholder.
- Timestamp format: `YYYYMMDD-HHmmss` for the directory name; ISO 8601 for `Started:`.
