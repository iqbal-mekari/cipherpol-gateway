---
name: qa-create-patrol-testcase
description: Author one atomic Patrol testcase Dart file (AAA pattern, single screen/interaction) from a confirmed test case row. Called by qa-automation-worker.
user-invocable: false
---

Write exactly one atomic Patrol testcase file per the Patrol authoring standard.

## Steps

1. Load `$CLAUDE_PLUGIN_ROOT/reference/qa/patrol-standard.md` and `$CLAUDE_PLUGIN_ROOT/reference/qa/patrol-selector-rules.md`. STOP and report a reference gap if either is missing.
2. Read the target screen source (`lib/src/features/<feature>/presentation/screens/*_screen.dart`) for existing `Key(...)` and `Semantics(identifier: ...)` values.
3. Derive the file name `<verb>_<target>.dart` (e.g. `tap_login_button.dart`) and write it to `integration_test/testcases/<screen>/<verb>_<target>.dart`, following the testcase template: AAA structure, no navigation, selector chosen per the priority hierarchy in `patrol-selector-rules.md`.
4. **Mock arrangement:** load `$CLAUDE_PLUGIN_ROOT/reference/qa/hermetic-mock-standard.md` and arrange the row's taxonomy case via `MockControl` — inline in the Arrange step if POST-BOOT, or note it as a boot-time arrangement for the caller to carry up to the scenario level if BOOT-TIME. Tag the test `mockonly` if it injects an error or latency.
5. Validate with `patrol develop --target integration_test/testcases/<screen>/<verb>_<target>.dart -d <device>`; iterate (edit + hot-restart) until it passes before declaring done.

## Rules

- Never use `$.native.tap(Offset(x, y))` or any coordinate-based selector.
- Never call another testcase's function from inside a testcase.
- No navigation logic — a testcase assumes it is already on the target screen.
- No hardcoded credentials, tokens, or personal data.

## Output

File path written, selector strategy used (text / key-semantics / ancestor-chaining / containing / new-semantics), and the validation result (`patrol develop` pass/fail).
