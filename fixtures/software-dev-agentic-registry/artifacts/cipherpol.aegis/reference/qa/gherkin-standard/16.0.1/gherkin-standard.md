# Gherkin Test-Case Authoring Standard

> Related: pokayoke-integration.md, qa-gates.md, qa-testcase-worker.md, qa-automation-worker.md, qa-sync-worker.md

The canonical standard for authoring and maintaining mobile UI test cases in the `testcases/` corpus of a downstream project. Centralizes the CSV schema, Gherkin steps convention, ID grammar, priority mapping, coverage rules, and validation that would otherwise be redefined per skill. Every QA agent and skill that reads, writes, or validates `testcases/` conforms to this document.

## Scope Restriction

Test cases in this corpus cover **mobile UI interactions only**. Every case must be expressible as one or more of: tap, swipe, scroll, type, long-press, assert visible/hidden, assert text, assert enabled/disabled, navigate, wait for element.

Do NOT author:
- API / endpoint test cases (request/response validation)
- Web application test cases
- Backend / service test cases
- Performance / load test cases
- Database test cases

If a requirement can only be verified by inspecting a network call, a database row, or a service response, it does not belong in this corpus — flag it for a different test layer instead of forcing a UI-only case around it.

## The 16-Column CSV Schema

Every file at `testcases/<feature>/<feature>_test_cases.csv` uses this exact header, in this exact order:

```
id,platform,feature,title,priority,module_path,preconditions,steps,expected_result,references,tags,automated_status,ai_status,flag,test_rail_case_id,notes
```

| Column | Meaning | Allowed values / format |
|---|---|---|
| `id` | Frozen unique identifier | `<PLATFORM>-<FEATURE>-<NNN>` — e.g. `MOB-CAT-006`. See ID Grammar below. |
| `platform` | Target platform | Must match a registered platform name in `registry.yaml` (e.g. `mobile`) |
| `feature` | Feature/module name, for git-side organization | Matches `registry.yaml` `features[].feature`; not synced to pokayoke |
| `title` | Short human-readable case title | Free text |
| `priority` | Severity | `high` / `medium` / `low` — see Priority Mapping below |
| `module_path` | Module hierarchy shown in the SDET platform | Sourced from `registry.yaml` `features[].module_path`, e.g. `Catalog > Product List` |
| `preconditions` | Setup required before `steps` run | Free text, or `\|`-joined list of conditions |
| `steps` | The Gherkin clauses | `\|`-joined clauses, each starting `Given`/`When`/`Then`/`And`/`But` — see Steps Rule below |
| `expected_result` | The outcome asserted by the case | Free text describing observable UI state; source of the `Then` clause(s) |
| `references` | Traceability links | Free text — ticket ids, design links; semicolon-separated if multiple |
| `tags` | Classification labels | `\|`-joined, lowercase-kebab — see Smoke vs Regression below |
| `automated_status` | Automation progress | `not yet` / `manual` / `in progress` / `automated` |
| `ai_status` | AI-authorship review state | `full` / `partial` / `no` |
| `flag` | Attention/archival marker | `"true"` / `"false"` (string in the CSV cell) |
| `test_rail_case_id` | Legacy lineage id, if any | Free text, e.g. `AUTH-001`; blank when there is no legacy ancestor |
| `notes` | Free text commentary | `[ARCHIVED] <reason>` prefix marks a retired case; not synced |

## The Gherkin Steps Rule

`steps` is a single CSV cell containing every clause of the case, joined by ` \| `. Each clause starts with one of `Given`, `When`, `Then`, `And`, `But`. Every case needs **at least one `Given` and one `Then`** — `When`/`And`/`But` are used as needed but are not independently required.

Worked example:

```
Given the user is on the catalog screen | When they tap a product | Then the product detail sheet opens
```

`Then` clauses should assert the same outcome recorded in `expected_result` — never restate an action as if it were an assertion.

## ID Grammar and the Registry Contract

Grammar: `<PLATFORM>-<FEATURE>-<NNN>`, e.g. `MOB-CAT-006`.

- `<PLATFORM>` — the platform code, from `testcases/registry.yaml`'s `platforms:` map (e.g. `mobile: MOB`).
- `<FEATURE>` — the feature prefix, from the matching entry in `registry.yaml`'s `features:` list.
- `<NNN>` — a zero-padded 3-digit sequence, allocated sequentially **within that feature prefix**.

Rules:
- **Never invent a prefix.** Look up the feature in `registry.yaml` first; if it is not registered, stop and ask rather than guessing one.
- **Prefixes are frozen.** They are never renamed or reused for a different feature — Patrol test labels and pokayoke sync history depend on them staying stable.
- **Next-free-number allocation** — for a new case in an existing feature, scan the feature's CSV for the highest existing `<NNN>` under that prefix and allocate the next integer, zero-padded to 3 digits.
- **IDs are never renumbered or re-prefixed**, even when a case's content changes substantially. An update preserves the id; see Archive, Never Delete below for removals.

## Priority Mapping

| Priority (legacy) | `priority` column | Definition |
|---|---|---|
| P0 | `high` | Core functionality, data integrity, security, blocking flows — the feature is broken for this scenario if it fails |
| P1 | `medium` | Important UX, secondary features, non-blocking validation |
| P2 | `low` | Cosmetic behavior, extreme edge cases, nice-to-have |
| P3 | `low` | Minor polish, rarely encountered scenarios |

Only `high` / `medium` / `low` are ever stored in the CSV; P0–P3 is authoring-time shorthand for choosing the right bucket, not a stored value.

## Smoke vs Regression

There is **no separate smoke CSV file** — smoke is a `tags` value on a row inside the feature's single canonical CSV.

- **Smoke** — tag `smoke`. Assign when the case is the core happy-path journey for a feature, the feature is fundamentally broken if it fails, and it carries no edge/boundary/error condition. Typically `high` priority.
- **Regression** — everything else: edge cases, boundary values, negative/error scenarios, permission and offline failures, platform-specific behavior, secondary flows. No tag is required to mark a case as regression — its absence from `smoke` is sufficient, though descriptive tags (`negative`, `edge`, `offline`) are encouraged.

Other reserved cross-cutting tags: `offline`, `online` (connectivity scenarios), `release-gate` (a project-defined gated-release subset). Projects may add their own segment/vertical tags as needed — keep them flat and `\|`-joined, never a separate folder or id prefix.

## Coverage Rules

- Every acceptance criterion maps to **at least one** test case.
- Every happy path has **at least one** corresponding negative case.
- **Offline scenarios are mandatory** for any feature with offline-relevant behavior (offline-first mobile apps) — connectivity loss, queued actions, sync-conflict resolution, reconnection integrity.
- Tag platform-specific behavior explicitly (e.g. Android back button vs. iOS swipe-back) rather than leaving it implicit in the steps text.

## Markdown Reference Notes

Alongside each `<feature>_test_cases.csv`, maintain human-readable markdown notes in `testcases/<feature>/` — one entry per case, grouped under the feature and originating ticket:

```markdown
# Feature: <Feature Name>
## Related Ticket: <TICKET-ID>

### MOB-CAT-006: <Test Case Title>
- **Priority:** high / medium / low
- **Type:** Happy Path / Edge Case / Error Case / Integration
- **Preconditions:** <setup required>
- **Steps:** Given… | When… | Then… (Gherkin, joined by `|`)
- **Expected Result:** <what should happen>
- **Tags:** smoke | regression | offline | <project-defined tags>
```

The CSV is the canonical, machine-consumed record; the markdown notes are the human-readable companion — keep both in sync when a case changes.

## Archive, Never Delete

Retiring a test case never removes its row. Instead:
1. Prepend `[ARCHIVED] <reason>` to the `notes` column.
2. Set `flag` to `"true"`.
3. Leave the `id` untouched.

This preserves history for anything that referenced the id (Patrol test labels, pokayoke sync lineage, prior reports). Never hard-delete a row and never renumber the ids that follow it.

## Validation

If `scripts/harness/checks/check_testcases.sh` exists in the downstream project, run it and require exit 0:

```bash
bash scripts/harness/checks/check_testcases.sh testcases
```

If it does not exist, validate manually and say so explicitly in the report. Manual checks mirror what the script enforces:
- The header row exactly matches the canonical 16 columns, in order.
- Every `id` matches `<PLATFORM>-<FEATURE>-<NNN>` with a registered platform code and feature prefix, and the `platform` column agrees with the id's platform code.
- `priority` is one of `high` / `medium` / `low`.
- `steps` is `\|`-separated, every clause starts with `Given`/`When`/`Then`/`And`/`But`, and at least one `Given` and one `Then` are present.
- `automated_status` and `ai_status` are within their enums.
- No `id` repeats within the same platform across the whole corpus.

Refuse to proceed (generation, automation, or sync) on a corpus that fails validation — report the errors instead.

## Coverage Matrix

Maintain `testcases/README.md` as the corpus-wide coverage matrix, one row per feature:

| Feature | File | Total | Smoke | Regression | High | Medium | Low |
|---|---|---|---|---|---|---|---|

Update the feature's row whenever its CSV changes count or priority mix.
