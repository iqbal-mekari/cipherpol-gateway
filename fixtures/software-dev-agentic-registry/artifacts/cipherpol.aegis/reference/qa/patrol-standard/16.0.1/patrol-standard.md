# Patrol Test-Authoring Standard

> Related: patrol-selector-rules.md, patrol-failure-patterns.md, qa-testcase-worker.md, qa-automation-worker.md, qa-debug-worker.md, hermetic-mock-standard.md

The authoritative standard for writing Patrol UI tests (Dart) for Flutter mobile apps. Covers folder structure, naming, the seven authoring rules, common patterns, pitfalls, MCP tool usage, and minimal inline templates.

## Authority Rule <!-- 4 -->

**This document wins.** When executing any QA persona work that writes or edits Patrol test files, ignore whatever test patterns already exist in the downstream repo's `integration_test/` tree. Legacy files may use outdated folder layouts, naming, or selector styles — they are not a precedent. Only the structure, naming, and rules defined here are authoritative. If an existing file conflicts with this standard, the existing file is wrong, not this document.

## Core Concepts: Testcase vs Scenario <!-- 10 -->

| Aspect | Testcase | Scenario |
|---|---|---|
| Purpose | Atomic test — single action/verification | User journey — orchestrates multiple testcases |
| Scope | Single screen, single interaction | Multiple screens, complete flow |
| Structure | AAA (Arrange-Act-Assert) | Orchestrates testcases + state management |
| Reusability | Reused across scenarios | Self-contained user journey |
| Example | `tap_login_button.dart` | `login_success_and_failure.dart` |

## Folder Structure <!-- 29 -->

```
integration_test/
├── testcases/           # Atomic tests (AAA pattern), one folder per screen
│   ├── login/
│   │   ├── verify_login_form_visible.dart
│   │   └── tap_login_button.dart
│   └── home/
│       └── verify_welcome_visible.dart
├── scenarios/           # User journeys (orchestrates testcases), one folder per feature
│   └── login/
│       └── login_success_and_failure.dart
├── helpers/             # Shared helper functions (launch, login, logout, cart, etc.)
│   ├── app_helper.dart    ← launchApp($) — MUST be the first call in every patrolTest
│   ├── login_helper.dart  ← loginHelper($) — launches + signs in (calls launchApp internally)
│   └── ...
└── utils/               # Dart utilities & locale setup
    ├── locale_helper.dart
    └── test_config.dart
```

**Helper contract:**

| Helper | Signature | Behavior |
|---|---|---|
| `launchApp($)` | `Future<void> launchApp(PatrolIntegrationTester $)` | Boots the app (`app.main()`), waits for the widget tree to settle. Must be the first statement of every `patrolTest`. |
| `loginHelper($)` | `Future<void> loginHelper(PatrolIntegrationTester $)` | Calls `launchApp($)` internally, then performs the sign-in flow. Use for tests that need to start post-login. |

## Naming <!-- 8 -->

- Format: `<verb>_<target>.dart` — e.g. `tap_login_button.dart`, `verify_welcome_visible.dart`, `enter_search_query.dart`.
- Start with an action-based verb: `tap_`, `verify_`, `check_`, `enter_`, `select_`, etc.
- **No ticket-ID suffixes** — never `tap_login_button_C123456.dart`.
- **No ordering numbers** — never `01_tap_login_button.dart`.
- Folder name matches the screen or feature it covers (`testcases/login/`, `scenarios/checkout/`).

## Rule 1 — Screen-Scope + Function-Call Policy <!-- 14 -->

Each `testcases/<screen>/` folder maps 1-to-1 with a screen (or a major section of a screen). It covers everything a user can do there: layout checks, interactions, error states.

- Shared screens may already have testcases from other features — scan existing files before adding new ones; reuse an equivalent test instead of duplicating.
- **Testcases:**
  - NEVER call other testcase functions from a testcase. Testcases are atomic.
  - MAY use `if (await $('text').exists)` for conditional execution.
  - MAY use `while`/`for` loops for repeating patterns.
- **Scenarios:**
  - PRIORITIZE calling existing testcase functions — compose journeys from reusable atomic tests.
  - USE `helpers/` for shared multi-step flows (login, logout, launch).
  - AVOID duplicating testcase logic inline — inline code only when no testcase exists for that action.

## Rule 2 — Selectors <!-- 6 -->

Never use point coordinates. Selector priority: text → key/Semantics identifier → widget-type + ancestor chaining → `containing`/relative positioning → add `Semantics(identifier: ..., container: true)` and rebuild.

**Full reference:** see [patrol-selector-rules.md](./patrol-selector-rules.md) for the complete priority hierarchy, code examples, accessibility node merging, the selector decision tree, and timeout conventions.

## Rule 3 — Always Verify Copy Against Screen Source AND ARB Files <!-- 23 -->

Every string passed to `$()`, `expect()`, or `waitUntilVisible()` MUST be verified against actual app text before it is written into a test — never guessed.

**Two-step verification (mandatory before writing Dart):**

1. **Step A** — Find the string's key in the screen source file (e.g. `l10n.loginButtonLabel`).
2. **Step B** — Look up that key in the ARB file to get the literal rendered string. If the string is parameterized, match the filled-in value, not the template literal.

**Accessibility node merging** — Flutter often merges a label + value into a single accessibility node (e.g. a `Row` inside a list tile). `$('Field label')` fails if the actual node text is `"Field label\nField value"`. Detect and fix this per [patrol-selector-rules.md](./patrol-selector-rules.md#accessibility-node-merging).

**Localization options:**

```dart
// Option 1: Direct text matching (simpler, but locale-dependent)
await $('Login').tap();

// Option 2: Using the app's localization class (locale-agnostic)
await $(find.text(AppLocalizations.of($.native).loginButtonLabel)).tap();
```

Check the project's default locale before writing selectors. When a screen supports multiple locales, verify the key against every ARB file the test may run under, not just the default.

## Rule 4 — Never Hardcode Credentials <!-- 4 -->

Use environment variables or dedicated test accounts. Never commit real credentials, tokens, or personal data into a test file.

## Rule 5 — Running Tests <!-- 21 -->

| Method | When to use | Command |
|---|---|---|
| `patrol develop` | Iterative debugging, writing tests, fixing selectors | `patrol develop --target integration_test/testcases/<screen>/<file>.dart -d <device>` |
| `patrol test` | Final validation before committing | `patrol test --target integration_test/testcases/<screen>/<file>.dart -d <device>` |

`patrol develop` is the primary tool for test development. It keeps the app installed and hot-restarts on each run (type `r` to re-run), eliminating rebuild overhead between iterations.

**Native-tree-first failure workflow:**

1. Inspect the native view hierarchy FIRST — `mcp__patrol__native-tree` — the device stays on the screen where the test stopped; this is the primary diagnostic context.
2. Diagnose from the hierarchy output: match selector strings against actual `text`, `label`, `identifier`, and `resourceName` values.
3. Edit the Dart test file with the proposed fix.
4. Re-run via `patrol develop` (hot-restart with `r`) to validate immediately.
5. If still failing, inspect native-tree again and repeat from step 2.

**NEVER use screenshots for investigation** — `mcp__patrol__native-tree` is the sole visual diagnostic tool. Screenshots are ambiguous and cannot reveal merged nodes, identifiers, or duplicate text.

Premature failures in the 10–30 s range: retry up to 3 times before treating them as a real failure.

## Rule 6 — Correct Text Input Pattern <!-- 15 -->

`enterText` combines tap + focus + type into a single call. Do not tap the field first.

```dart
// CORRECT
await $(#emailField).enterText('test@example.com');
await $(#passwordField).enterText('SecurePass123!');
await $('Login').tap();

// INCORRECT — enterText already handles focus, a preceding tap is redundant
await $(#emailField).tap();
await $(#emailField).enterText('test@example.com');
```

## Rule 7 — Timeout Conventions <!-- 8 -->

| Situation | Approach |
|---|---|
| Wait for an element to appear | `$('text').waitUntilVisible()` |
| Wait for animations to settle | `await $.pumpWidgetAndSettle()` |
| Slow network/loading transitions | `$('text').waitUntilVisible(timeout: Duration(seconds: 10))` |

## App Launch — Mandatory First Line (Every Test) <!-- 30 -->

Every `patrolTest` — both testcases and scenarios — **must** call `launchApp($)` (or `loginHelper($)`) as its very first line. Without it the screen is black and the test closes immediately — this failure mode looks like a selector problem but is actually a missing app bootstrap.

```dart
import '../../helpers/app_helper.dart'; // adjust relative path to depth

patrolTest('MOB-CAT-006: description', ($) async {
  await launchApp($);           // ← ALWAYS first, no exceptions
  // test steps here
});
```

`launchApp` boots the app (DI, routing, any startup services) then waits for the widget tree to settle. It is defined in `integration_test/helpers/app_helper.dart`.

**Clean state per test:** each test must run against a completely clean app state — no shared preferences, no auth tokens, no cached data — as if freshly installed. On Android this is typically guaranteed by `clearPackageData = "true"` together with `ANDROIDX_TEST_ORCHESTRATOR` in the app's Gradle config; confirm the equivalent is configured for the downstream project before relying on clean-state assumptions.

For tests that need to start post-login, use `loginHelper($)` instead — it calls `launchApp($)` internally then performs sign-in:

```dart
import '../../helpers/login_helper.dart';

patrolTest('MOB-CAT-006: post-auth test', ($) async {
  await loginHelper($);         // launches + signs in
  // continue from home screen
});
```

**Never** call bare `$.pumpAndSettle()` as the first statement — the app has not been started and there is nothing to settle.

## Mock Mode (hermetic backend) <!-- 28 -->

Mock mode is the **required default** execution mode for all UI automation generated by this pipeline — hermetic (`integration_test/helpers/mock_server.dart` + `mock_control.dart`) unless the scenario is explicitly excepted below. A missing mock backend is a **blocking precondition**, not a gracefully-degraded fallback: run `/qa-generate-mock` to produce it before any UI automation proceeds. Real-backend execution is the exception, not the default — it applies only to scenarios not tagged `mockonly`, and only when the user/operator explicitly requests a real-backend run. When the mock backend is present, Patrol tests consume it under the following contract.

**Boot ordering** — `launchApp($)` (the repo's mock-aware launch helper) must, in order: await the mock server listening → seed the session → start the app (`app.main()`). Never reverse this order — starting `app.main()` before the server is listening races the app's first request against the socket bind.

**Lifecycle hooks** (all three required in a mock-mode suite):

| Hook | Call | Why |
|---|---|---|
| `setUpAll` | `clearAppData` | Clean app state once per suite, same as non-mock runs. |
| `setUp` | `resetMockServerState` | Clears per-scenario overrides/state before each test — prevents bleed-through between tests. |
| `tearDown` | `stopMockServer` | **Load-bearing** — a live server socket keeps the test isolate alive; skipping this hangs the run or the device between scenarios. |

**Running in mock mode:**

```
patrol test --target integration_test/testcases/<screen>/<file>.dart -d <device> --dart-define=ENV=MOCK
```

Same `patrol develop`/`patrol test` commands as Rule 5, with the mock env define added.

**The `mockonly` tag** — scenarios/testcases that inject errors or latency (only possible via the mock server) are tagged `mockonly`. Real-backend runs exclude this tag; mock-mode runs include it.

**Folder additions** in a mock-aware repo: `integration_test/fixtures/mock/` (fixtures + manifest) and `integration_test/helpers/mock_*.dart` (server, control facade, session seeding) alongside the existing `helpers/`/`utils/` folders above.

`hermetic-mock-standard.md` is the authority for all mock-backend internals (pipeline, fixtures, arrange facade, honesty gates). This section governs only how Patrol tests consume it.

## Common Patterns <!-- 50 -->

**Conditional execution** — run code only when an element is visible:

```dart
if (await $('Login Button').exists) {
  await $('Login Button').tap();
}
```

**State reset between error paths** — navigate back to a known state before an independent error scenario:

```dart
await verifyLoginSuccess($);   // happy path
await navigateToHome($);       // reset state
await performLogout($);
await verifyLoginFailure($);   // error path, starts clean
```

**Retry/repeat loops:**

```dart
// Repeat while an element is visible
while (await $('Load More').exists) {
  await $('Load More').tap();
  await $.pumpWidgetAndSettle();
}

// Retry a tap when the screen may not be ready yet
for (var attempt = 0; attempt < 3; attempt++) {
  await $('Target Button').tap();
  if (await $('Expected Next Screen Element').exists) break;
  await $.pumpWidgetAndSettle();
}
```

**Parameter passthrough** — scenarios pass test data into testcases via function parameters; testcases document required parameters in their signature:

```dart
// In scenario:
await selectOption($, optionValue: 'Test Name');

// In testcase (select_option.dart):
Future<void> selectOption(PatrolIntegrationTester $, {required String optionValue}) async {
  await $(#optionDropdown).tap();
  await $(#searchField).enterText(optionValue);
  await $(optionValue).tap();
}
```

## Common Pitfalls <!-- 14 -->

| Pitfall | Why it's wrong | Correct approach |
|---|---|---|
| Using coordinates | Fragile, breaks on different screen sizes | Use text/key selectors |
| Hardcoded strings | May not match actual app text | Use `AppLocalizations` or verify against ARB files |
| Calling testcase functions from testcases | Testcases must be atomic/simple | Scenarios handle orchestration; testcases only use conditionals/loops |
| Duplicating testcases | Maintenance nightmare | Reuse existing testcases |
| Skipping state reset | Flaky tests due to leftover state | Reset between independent scenarios |
| Not using ancestor chaining for duplicates | Taps the wrong element when text appears multiple times | Use `$(Parent).$('text').tap()` for disambiguation |
| Not using `container: true` in Semantics | Widget children not exposed to accessibility | Always add `container: true` when adding Semantics for testing |
| Exact text match on label+value nodes | Flutter Row widgets merge label+value into one node | Use `containing` finder or match the full merged text |
| `$.native.tap(Offset(x, y))` | Coordinates break across screen sizes/densities | Use text/key selectors, add Semantics if needed |

## Patrol MCP Tool Usage <!-- 12 -->

| Tool | Purpose | Notes |
|---|---|---|
| `mcp__patrol__run` | Run a Dart test file — starts a `patrol develop` session or hot-restarts an existing one | Waits for the run/restart to settle before returning |
| `mcp__patrol__status` | Get session status and recent logs | Use when a run's outcome is unclear |
| `mcp__patrol__native-tree` | Fetch the live native UI view hierarchy | Primary — and only — visual diagnostic tool |
| `mcp__patrol__quit` | Quit the active Patrol session | Call when a run is finished or wedged |
| `mcp__patrol__screenshot` | Exists, but **BANNED** for investigation | Never call it for diagnosing a failure — use `native-tree` instead |

**Patrol cannot run inline Dart code.** There is no REPL — always write the complete test file, then run it. The only development loop is **write → run → inspect (native-tree) → edit → re-run**.

## Inline Templates <!-- 62 -->

Reference template files are not shipped separately — the two patterns below are the complete minimal shape. Copy and adapt; do not invent a different structure.

### Testcase template (AAA, single screen)

```dart
import 'package:patrol/patrol.dart';

import '../../helpers/app_helper.dart';

/// Atomic testcase: taps the login button and asserts navigation.
/// Assumes the test is already on the login screen (no navigation here).
Future<void> tapLoginButton(PatrolIntegrationTester $) async {
  // Arrange — confirm the screen is in the expected starting state.
  await $('Login').waitUntilVisible();

  // Act — perform the single interaction under test.
  await $('Login').tap();
  await $.pumpWidgetAndSettle();

  // Assert — verify the expected outcome.
  expect($('Home'), findsOneWidget);
}

patrolTest('MOB-LOG-002: tap login button navigates to home', ($) async {
  await launchApp($);            // mandatory first line
  await tapLoginButton($);
});
```

### Scenario template (orchestrates testcases, happy path + error path)

```dart
import 'package:patrol/patrol.dart';

import '../../helpers/app_helper.dart';
import '../../testcases/login/enter_login_credentials.dart';
import '../../testcases/login/tap_login_button.dart';
import '../../testcases/login/verify_login_error_visible.dart';

patrolTest('MOB-LOG-010: login success and failure journey', ($) async {
  await launchApp($);            // mandatory first line

  // Happy path — prioritize existing testcase functions, do not duplicate logic.
  await enterLoginCredentials($, email: 'valid@example.com', password: 'Valid123!');
  await tapLoginButton($);
  expect($('Home'), findsOneWidget);

  // Reset to a known state before the independent error path.
  await $('Logout').tap();
  await $.pumpWidgetAndSettle();

  // Error path.
  await enterLoginCredentials($, email: 'valid@example.com', password: 'wrong');
  await tapLoginButton($);
  await verifyLoginErrorVisible($);

  // End on a distinctive landmark element for the final screen.
  expect($('Login'), findsOneWidget);
});
```
