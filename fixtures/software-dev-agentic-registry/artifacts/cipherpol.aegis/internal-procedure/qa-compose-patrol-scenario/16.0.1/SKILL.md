---
name: qa-compose-patrol-scenario
description: Compose one Patrol scenario Dart file that orchestrates confirmed testcase files into an end-to-end user journey. Called by qa-automation-worker.
user-invocable: false
---

Write exactly one scenario Dart file from a confirmed list of testcase files.

## Steps

1. Load `$CLAUDE_PLUGIN_ROOT/reference/qa/patrol-standard.md`. STOP and report a reference gap if it is missing.
2. Read the provided testcase files and `integration_test/helpers/` to inventory callable functions (including `launchApp($)` / `loginHelper($)`) and their parameters.
3. Write `integration_test/scenarios/<feature>/<journey>.dart` per the scenario template: import the testcase functions, set up launch/login first, orchestrate the happy path before error paths, insert a state reset between each independent error path, and end on a landmark assertion for the final screen.
4. **Mock arrangement:** if any composed testcase carries a BOOT-TIME arrangement, load `$CLAUDE_PLUGIN_ROOT/reference/qa/hermetic-mock-standard.md` and arrange it via the arrange-on-next-launch hook before `launchApp($)`/`loginHelper($)`. If any composed testcase is tagged `mockonly`, propagate that tag to the scenario.
5. Validate end-to-end: iterate via `patrol develop --target integration_test/scenarios/<feature>/<journey>.dart -d <device>` (hot-restart per fix) until passing, then confirm with a clean `patrol test --target ... -d <device>` run.

## Rules

- Call existing testcase functions for every action a testcase already covers — write inline logic only when no testcase exists for that action.
- Scenarios own lifecycle and setup (launch, login, state resets); testcases never contain lifecycle logic.
- If a bug surfaces during validation, fix it in the scenario file only — never edit a testcase file from this procedure.

## Output

Scenario path written, testcases orchestrated (in call order), and the validation result (`patrol develop` + `patrol test` pass/fail).
