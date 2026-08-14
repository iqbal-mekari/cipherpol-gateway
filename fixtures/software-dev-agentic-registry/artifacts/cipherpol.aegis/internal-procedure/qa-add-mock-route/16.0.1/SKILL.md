---
name: qa-add-mock-route
description: Add one endpoint's fixture and manifest route to the hermetic mock backend — capture-first fixture body, taxonomy classification, manifest entry, and per-fixture honesty checks. The reusable atomic unit for both scaffold and extend modes. Called by qa-mock-worker.
user-invocable: false
---

Write exactly one fixture + manifest entry per confirmed endpoint from the Gate M inventory.

## Steps

1. Load `$CLAUDE_PLUGIN_ROOT/reference/qa/hermetic-mock-standard.md`. STOP and report a reference gap if missing.
2. **Produce the fixture body** per §10 capture-first/synthesize-fallback: if the user supplied a real captured response, freeze it verbatim (redact secrets/PII, preserve shape and values); only when none exists, synthesize from the app's response model or the OpenAPI schema and mark it flagged-for-review in this skill's output (never inside the JSON body itself).
3. **Classify** the case per the §5 taxonomy table (happy-path, empty, variant, error, state-dependent, sequenced, latency, stateful mutation, echo, growing collection, alternate context, payload assertion) — this determines which pipeline stage and facade call the case belongs to.
4. **Write the fixture** to `integration_test/fixtures/mock/<resource>[_<qualifier>].json` (lowercase snake_case, §12 naming rule) — never rename an existing overlay-backed fixture.
5. **Append the manifest entry** to `integration_test/fixtures/mock/manifest.json` per the §4a schema (`method`, `path` regex anchored with `^`, `file`, optional `status`) — insert specific routes before broader-prefix routes so first-match-wins resolves correctly; never reorder existing entries.
6. **Wire usage notes** for the case class into the Gate M-approved arrangement plan: override/`stubOnce`/`delay` for cases resolved at pipeline stage ③/②, or a note that this route resolves at the base stage ⑥ with no runtime arrangement needed.
7. Regenerate the fixtures map (`dart run tool/gen_mock_fixtures.dart`).
8. Run the structural gate and add this fixture to the semantic contract test's `contracts` map, pointing at the endpoint's real response model (fall back to the shared envelope shape if none is dedicated).

## Rules

- Never touch a fixture or manifest entry outside this route — in `extend` mode, unrelated existing entries are untouched.
- Never route on headers or query params (query is stripped) beyond the one documented exception already in place, if any.
- A synthesized fixture is always flagged — never presented as equivalent to a captured one.

## Output

Fixture path, manifest entry added, case class, source (`captured` | `synthesized-flagged`).
