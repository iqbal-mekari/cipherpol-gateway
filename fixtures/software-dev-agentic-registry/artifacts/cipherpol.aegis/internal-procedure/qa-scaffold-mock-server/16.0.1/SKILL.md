---
name: qa-scaffold-mock-server
description: One-time bootstrap of the hermetic mock backend harness — writes the shelf server pipeline, arrange facade, session seeding, launchApp boot ordering, env seam, empty manifest, fixtures codegen, and the two honesty-gate files. Called by qa-mock-worker.
user-invocable: false
---

Write the coherent harness set for a brand-new hermetic mock backend, using the approved discovery table from Gate M. Run only once per app — never when a mock backend already exists.

## Steps

1. Load `$CLAUDE_PLUGIN_ROOT/reference/qa/hermetic-mock-standard.md`. STOP and report a reference gap if it is missing.
2. Confirm every `<DISCOVERED: …>` placeholder needed below has a value in the approved discovery table. STOP and report if any is missing — never substitute a default or a mekaripos value.
3. Write the canonical layout (§12), substituting discovered values into the code skeletons (§Code skeletons):
   - `integration_test/helpers/mock_server.dart` — the 7-stage pipeline (§3), with only the stateful stores this run's approved inventory actually needs.
   - `integration_test/helpers/mock_control.dart` — the arrange facade (§6).
   - `integration_test/helpers/mock_session.dart` + `mock_seed_helpers.dart` — programmatic session seeding (§2b), writing through the discovered storage factory and session keys, synthetic identities only.
   - `integration_test/helpers/app_helper.dart` — `launchApp($)` boot ordering (§7).
   - The env seam (§2a) — wire the discovered env flag / isMock check to resolve BASE_URL to `http://127.0.0.1:<DISCOVERED: port>`, in the app's existing env-selection mechanism, never a new `if` in the HTTP client.
   - `integration_test/fixtures/mock/manifest.json` — empty ordered array (§4a); fixtures/routes are added by `qa-add-mock-route`, not here.
   - `tool/gen_mock_fixtures.dart` + an initial empty `integration_test/fixtures/mock_fixtures.g.dart` (§4b, §Code skeletons).
   - `scripts/harness/checks/check_mock_fixtures.dart` — the structural honesty gate (§11).
   - `test/.../mock/fixture_contract_test.dart` — the semantic honesty gate (§11), with an empty `contracts` map (populated as routes are added).
4. Regenerate the fixtures map (`dart run tool/gen_mock_fixtures.dart`) and run `flutter analyze` on `integration_test/` and `tool/` — fix any error before declaring done.

## Rules

- Never hardcode a mekaripos value (port `8089`, `EnvConfig`, `/app/v1`, …) — every seam value comes from the discovery table.
- Everything written lives under `integration_test/`, `tool/`, `scripts/harness/checks/`, or `test/` — nothing is declared as a pubspec asset, nothing ships in the release binary.
- Do not add any endpoint-specific route or fixture here — that is `qa-add-mock-route`'s job.

## Output

Paths written, and the discovered seam values substituted (port, env flag, base-URL config, storage factory, session keys, entrypoint).
