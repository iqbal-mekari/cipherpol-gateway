# Pokayoke Integration

> Related: gherkin-standard.md, qa-sync-worker.md

Sync contract between the canonical `testcases/` corpus and Mekari SDET's pokayoke test-case platform. This document is authoritative for the sync algorithm, field mapping, and hard rules — `qa-sync-worker` summarizes it, but this file governs.

## What Pokayoke Is

Pokayoke is Mekari's SDET test-case platform (`https://sdet-api.mekari.io`). A downstream project's `testcases/` corpus is mirrored into a pokayoke project via MCP, so that test-case history, execution tracking, and cross-team visibility live in one shared system instead of diverging between a git-tracked CSV and a separate SDET tool.

## MCP Registration and Auth

Register the server once per machine, user-scoped:

```bash
claude mcp add --scope user --transport http pokayoke-mcp https://sdet-api.mekari.io/mcp
```

Authenticate interactively — run `/mcp` in Claude Code, select `pokayoke-mcp`, choose Authenticate (OAuth browser flow). Verify with `claude mcp get pokayoke-mcp` → status `connected`. The same OAuth handshake is also reachable directly as an MCP tool pair, `mcp__pokayoke-mcp__authenticate` followed by `mcp__pokayoke-mcp__complete_authentication`, for flows that drive authentication from within a conversation rather than the `/mcp` menu.

**Hard caveat — no headless path.** Both routes require an interactive human completing an OAuth step in a browser. There is no service-token or CI-safe non-interactive path today. Any sync that depends on pokayoke connectivity must run through an MCP-capable agent with a human available to authenticate — it cannot be scripted into unattended CI.

## Tool Surface

| Tool | Purpose |
|---|---|
| `mcp__pokayoke-mcp__list_projects` | Enumerate pokayoke projects, to resolve/confirm a `projectId` |
| `mcp__pokayoke-mcp__test_case_list` | Paginated listing — the only supported way to build the remote id→dbId index |
| `mcp__pokayoke-mcp__test_case_get` | Fetch one remote case by `dbId`, when current field values are unclear |
| `mcp__pokayoke-mcp__test_case_create` | Insert a new remote case — a blind insert, not an upsert |
| `mcp__pokayoke-mcp__test_case_update` | Update a remote case by `dbId` |
| `mcp__pokayoke-mcp__test_case_delete` | Soft-delete a remote case by `dbId` |
| `mcp__pokayoke-mcp__authenticate` | Start the OAuth handshake |
| `mcp__pokayoke-mcp__complete_authentication` | Complete the OAuth handshake |

**Caveat:** this table reflects the canonical tool names as of this writing. MCP servers evolve — verify the live server's actual advertised tool list (e.g. via the client's MCP tool listing) before relying on it for a sync, since it may have drifted from this table.

## Hard Rules

1. **`id` is not globally unique remotely.** Only `dbId` is authoritative — two remote cases can share the same `id`/`platform`/`projectId` and both persist.
2. **`create` is not `upsert`.** A blind create loop duplicates the whole corpus on every run. Always build a paginated remote index first — page `test_case_list {projectId, page, limit: 100}` until `page >= totalPages` — before deciding create vs. update.
3. **Filter by the `platform` field, never by parsing the `id` substring.** The `id`'s platform-code prefix is a local authoring convention, not a safe remote filter key.
4. **`testRailCaseId` is read-only on create** — values sent in it are silently ignored. Carry that lineage in `references` instead (see field mapping below).

## `projectId` Source

`projectId` is read from `testcases/registry.yaml`'s `project_id` field for the downstream project — never hardcoded in any agent, skill, or script. If the registry or `project_id` is missing, stop and report the gap rather than guessing or falling back to a literal value.

## CSV → Sync-Payload Field Mapping

CSV schema and column meanings are defined in [`./gherkin-standard.md`](./gherkin-standard.md). This table covers only the sync-time transform:

| CSV column | Payload field | Transform |
|---|---|---|
| `id` | `id` | as-is |
| `platform` | `platform` | as-is |
| `title` | `title` | as-is |
| `priority` | `priority` | as-is (already `high`/`medium`/`low`) |
| `module_path` | `modulePath` | as-is (auto-creates modules remotely) |
| `preconditions` | `preconditions` | split on `\|` → array |
| `steps` | `steps` | split on `\|` → array (Gherkin lines) |
| `expected_result` | `expectedResult` | as-is |
| `references` | `references` | as-is; see `test_rail_case_id` row below for what gets appended |
| `tags` | `tags` | split on `\|` → array |
| `automated_status` | `automatedStatus` | as-is |
| `ai_status` | `aiStatus` | as-is |
| `flag` | `flag` | `"true"` → boolean `true` (and vice versa) |
| `test_rail_case_id` | `references` (appended) | **Never send as `testRailCaseId`** — read-only on create, silently ignored. Append its value into `references` instead (empty `references` → just the lineage id; with an existing value → `<existing>; <test_rail_case_id>`) |
| `feature` | — | drives the `id` prefix and folder locally; not synced |
| `notes` | — | free text; not synced |
| — | `projectId` | constant, from `registry.yaml` (see above) |

## Sync Algorithm

1. **Validate locally.** Run the schema/Gherkin validator from `gherkin-standard.md` (harness script if present, else the manual checks). Refuse to sync a corpus that fails validation.
2. **Fetch the paginated remote index.** Page `test_case_list {projectId, page, limit: 100}` until `page >= totalPages`; build `remote = {id -> dbId}`. If an `id` appears more than once remotely, flag it as a pre-existing duplicate for manual resolution — never silently pick one.
3. **Diff into a plan**, per row not excluded (see Exclusions below):
   - `id` not in `remote` → **CREATE**
   - `id` in `remote`, fields differ → **UPDATE**, sending only the changed fields (use `test_case_get` when the current remote value is unclear)
   - `id` in `remote`, fields identical → **SKIP**
4. **Dry-run by default.** Report the CREATE/UPDATE/SKIP counts and the first ~20 affected ids. Apply only on an explicit `--apply` invocation or explicit user confirmation in the conversation — never auto-apply on ambiguity.
5. **Report, and list soft-delete candidates without deleting.** Emit:

   | Outcome | Count |
   |---|---|
   | Created | N |
   | Updated | N |
   | Unchanged | N |
   | Remote-duplicates | N |
   | Soft-delete candidates | N |

   A soft-delete candidate is a remote id (matching `platform`) absent from the local CSVs. List them explicitly — **never delete automatically**; each deletion requires its own explicit per-id confirmation.

   Also surface remote duplicates found in step 2 as their own list (`<id> — dbId: <a>, <b>, ...`) — they need manual resolution and are never auto-merged.

## Mandatory Second-Pass Idempotency Check

Immediately after any `apply` run, re-run the dry-run a second time. Expect:

```
Created: 0   Updated: 0   Unchanged: N   Remote-duplicates: 0
```

A non-zero `Created` on this second pass is the canary for the create-duplicates hazard — stop, investigate, and do not run `apply` again until the cause is understood.

## Forbidden Operations

- A create loop with no prior `test_case_list` index (duplicates the corpus).
- Filtering or branching logic on the `id` substring — always use the `platform` field.
- Syncing prefixes excluded by the registry (see below) as if they were ordinary module cases.
- Sending `testRailCaseId` in any create or update payload.
- Deleting any remote case without an explicit per-id confirmation — no bulk/batch delete.

## Exclusion Mechanisms (`registry.yaml`)

- **`sync_excluded`** — a list of feature prefixes that are never synced (e.g. an internal contribution-harness prefix). These cases stay local-only.
- **`test_plan_prefixes`** — a list of prefixes that map to an external test-plan id rather than an ordinary module case; sync skips them the same way.

Both lists are read from `testcases/registry.yaml` at sync time — never hardcoded in agent/skill logic.

## Standalone Scope Note

This document covers the pokayoke sync contract only. It does not define the CSV schema itself (`gherkin-standard.md`) or the human-approval gates that precede automation (`qa-gates.md`) — sync is triggered independently of Gate 1/Gate 2 and may run any time the canonical corpus changes.
