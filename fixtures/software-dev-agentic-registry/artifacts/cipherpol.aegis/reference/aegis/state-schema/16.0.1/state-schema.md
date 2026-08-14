# State File Schema (`state.json`)

> Related: developer-feature-convergence-strategist.md · developer-feature-intent-strategist.md · developer-feature-worker.md · developer-ui-worker.md · developer-plan-feature/SKILL.md · developer-debug/SKILL.md · aegis-bootstrap-worker.md · developer-docs-worker.md

Canonical, versioned schema for `state.json` — the per-run state file written and read across persona lifecycles at `.claude/agentic-state/<persona>/.../<run>/state.json`. This doc codifies what is already in use by the writers/readers above; do not add a field here unless a writer actually emits it.

---

## Common Envelope <!-- 22 -->

Every `state.json` write includes these four keys at the top level, alongside whatever persona/skill-specific keys apply — `state.json` is one flat document per run, not a nested envelope + payload structure.

```json
{
  "schema_version": 1,
  "persona": "<developer | aegis | qa>",
  "skill": "<owning orchestrator skill name>",
  "phase": "<persona/skill-specific value — see sections below>",
  "updated_at": "<ISO 8601 timestamp>"
}
```

| Key | Required | Rule |
|---|---|---|
| `schema_version` | always | Current value: `1`. Every writer stamps it on every write — no exceptions, no conditional omission. |
| `persona` | always | Owning persona folder name (`developer`, `aegis`, `qa`). |
| `skill` | always | The orchestrator/trigger skill that owns this run (e.g. `developer-plan-feature`, `aegis-bootstrap-project`). |
| `phase` | always | Coarse lifecycle marker for this run — values are persona/skill-specific, documented per section below. |
| `updated_at` | always | Refreshed on every write, not just the first. |

## Forward-Compatibility Rule <!-- 8 -->

- **Writers** must always stamp `schema_version` on every write. A write with a missing or stale version is a writer bug, not a valid state.
- **Readers** must tolerate unknown keys — never fail or reset state because of a key the reader doesn't recognize. New keys are additive only.
- **Readers** encountering a missing or unrecognized `schema_version` must treat the file as legacy: proceed with a warning line (`[state.json] legacy or missing schema_version — proceeding`) rather than failing or discarding state.

---

## Docs Sync Block <!-- 16 -->

Cross-cutting — merged onto whatever `state.json` the run already has (or created new, for `developer-debug`, when a fix was actually synced). Written by `developer-docs-worker` after it runs. Read by the calling orchestrator (`developer-build-feature`, `developer-build-from-ticket`, `developer-debug`) as the completion gate — a run is not reported done until `docs.synced` is `true` or explicitly `skipped`.

```json
"docs": {
  "synced": true,
  "updated_at": "<ISO 8601>",
  "files": ["docs/features/<slug>.md", ...],
  "confluence": "ok | skipped | failed",
  "jira": "ok | skipped | failed"
}
```

---

## Per-Persona / Per-Skill Sections <!-- 89 -->

### developer — feature planning convergence (`developer-plan-feature`)

Written by `developer-feature-convergence-strategist` (`process-findings` mode, via `Bash` — the only state.json write this strategist performs) after each round. Read by `developer-feature-intent-strategist` (`planning.rounds` resume routing) and `developer-plan-feature/SKILL.md` (explicit run_dir checkpoint routing).

```json
{
  "schema_version": 1,
  "persona": "developer",
  "skill": "developer-plan-feature",
  "phase": "planning",
  "updated_at": "<ISO 8601>",
  "feature": "<name>",
  "platform": "<web | ios | flutter>",
  "planning": {
    "rounds": [
      { "round": 1, "planners": { "domain": "done", "data": "spawned", "pres": "failed" } }
    ]
  }
}
```

`phase` values: `planning` (rounds in progress) → `synthesized` (plan.md/context.md written).
`planners` status values: `spawned` → `done` | `failed`.

### developer — feature build execution (`developer-build-feature`, `developer-build-from-ticket`)

Written by `developer-feature-worker` and `developer-ui-worker` after each artifact completes. Read by both workers on resume (skip `completed_artifacts`, continue at `next_artifact`) and by `developer-plan-feature/SKILL.md`'s explicit run_dir checkpoint (`artifact_layers` derivation).

```json
{
  "schema_version": 1,
  "persona": "developer",
  "skill": "developer-build-feature",
  "phase": "in_progress",
  "updated_at": "<ISO 8601>",
  "feature": "<name>",
  "platform": "<web | ios | flutter>",
  "completed_artifacts": ["<ArtifactName>", ...],
  "artifacts": {
    "domain": ["<path>", ...],
    "data": ["<path>", ...],
    "presentation": ["<path>"],
    "ui": ["<path>", ...],
    "app": ["<path>", ...]
  },
  "stateholder_contract": "<path or null>",
  "next_artifact": "<name of next pending artifact or null>"
}
```

`phase` values: `in_progress` → `complete`.

### developer — debug convergence loop (`developer-debug`)

The normal debug path has no `state.json` — the investigation file at `.claude/agentic-state/developer/debug/<timestamp>-<slug>.md` is the durable record. A `state.json` is written only when the round cap (5) is exceeded without convergence, so the blocked state and open questions survive the session.

```json
{
  "schema_version": 1,
  "persona": "developer",
  "skill": "developer-debug",
  "phase": "blocked",
  "updated_at": "<ISO 8601>",
  "investigation_file": "<path>",
  "rounds_run": 5,
  "open_questions": ["<question>", ...]
}
```

### aegis — project bootstrap (`aegis-bootstrap-project`)

Written by `aegis-bootstrap-worker` at the end of Phase 2 (dependency resolution) and Phase 5 (verification). Write-only progress tracking — no reader resumes from it today.

```json
{
  "schema_version": 1,
  "persona": "aegis",
  "skill": "aegis-bootstrap-project",
  "phase": "resolved",
  "updated_at": "<ISO 8601>"
}
```

`phase` values: `resolved` (Phase 2 — dependency set resolved) → `verified` (Phase 5 — verification complete).

---

## Adding a New Writer <!-- 5 -->

1. Stamp the full common envelope on every write — `schema_version: 1` is non-negotiable.
2. Add a `### <persona> — <skill>` section here documenting the phase values and any skill-specific keys before shipping the writer.
3. If a reader for this state.json already exists elsewhere, update it to check `schema_version` per the Forward-Compatibility Rule above.
