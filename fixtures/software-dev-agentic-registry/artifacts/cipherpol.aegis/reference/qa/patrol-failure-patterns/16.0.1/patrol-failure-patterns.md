# Patrol Test Failure Patterns

> Related: patrol-standard.md, patrol-selector-rules.md, qa-debug-worker.md, hermetic-mock-standard.md

Curated knowledge base of known Patrol/Flutter failure root causes, how to diagnose them via `mcp__patrol__native-tree`, and the corrected code. Used by the debug workflow at Phase 3 (Diagnose) of `qa-debug-worker.md`.

## Scope and Local Extension <!-- 8 -->

This file ships **read-only** with the plugin — it holds app-agnostic Flutter/Patrol patterns only. Project-specific failure patterns discovered while debugging a downstream app (patterns tied to that app's own screens, BLoCs, or business rules) do **not** belong here. Append them instead to `.claude/agentic-state/qa/failure-patterns-local.md` in the downstream repo, using the exact same entry format (Error/Symptom → Root cause → Diagnosis → Fix), numbered sequentially within that file.

The debug worker **consults both files** during diagnosis: this file first (generic patterns are usually cheaper to rule in/out), then the local file (project-specific precedent). When a new root cause is confirmed and it is not app-specific, propose adding it here via the plugin's own contribution path rather than the local file.

---

## Pattern 1 — `pumpAndSettle` times out after a WebView redirect with ongoing async activity <!-- 27 -->

**Error:**
```
Timed out waiting for UI to settle
TimeoutException after 0:00:10.000000: Test timed out after 10 seconds.
```

**Root cause:** After a WebView-based redirect (SSO/OAuth callback, payment webview, etc.) closes and control returns to Flutter, there is ongoing BLoC/network activity (a data refresh fetch, an auth-state stream subscription) that prevents `pumpAndSettle` from ever settling. The framework remains in an "active" state indefinitely because something keeps scheduling frames.

**Diagnosis:** Occurs immediately after a WebView closes and the app returns to Flutter. The `pumpAndSettle` call hangs regardless of timeout extension — extending the timeout does not help because the underlying condition (continuous frame scheduling) never resolves on its own.

**Fix:** Replace `pumpAndSettle()` calls in this window with bounded `pump(duration)` polling instead:

```dart
// BEFORE (broken)
await $.pumpAndSettle();

// AFTER (fixed)
for (var i = 0; i < 30; i++) {
  await $.pump(const Duration(seconds: 1));
  if (someCondition) break;
}
```

---

## Pattern 2 — Native selectors (`$.native`) cannot find Flutter widgets <!-- 24 -->

**Error:**
```
NativeAutomatorException: Could not find element with selector ...
UiSelector.text("Item Name") — returns 0 elements
```

**Root cause:** Widgets rendered by the Flutter engine are NOT accessible via Android's `UiSelector.text()`. They appear in the platform accessibility tree as a single `contentDescription`/label node, not as individual native `text` nodes. `$.native.*` selectors use platform automation (UIAutomator on Android) which only matches native views.

**Diagnosis:** Use `mcp__patrol__native-tree` — Flutter-rendered text appears under a single accessibility node (often the whole Flutter surface), not as individually addressable `text`-attributed nodes the way native `Button`/`TextView` elements do.

**Fix:** Use Flutter-level `$()` selectors for Flutter-rendered widgets. Reserve `$.native` for genuinely native views (WebView HTML content, native dialogs, system permission prompts):

```dart
// BEFORE (broken — Flutter widget via native selector)
await $.native.tap(Selector(text: 'Item Name'));

// AFTER (fixed — Flutter widget via Flutter selector)
await $('Item Name').tap();
```

---

## Pattern 3 — `find.bySemanticsLabel` misses a button's `Semantics.identifier` <!-- 39 -->

**Error:**
```
Finder: bySemanticsLabel('confirm_button') — finds 0 widgets
Finder: bySemanticsLabel('primary_action') — finds 0 widgets
```

**Root cause:** A design-system button component (e.g. `AppButton(semantics: 'confirm_button')`) sets `Semantics(identifier: 'confirm_button', ...)`, NOT `Semantics(label: ...)`. `find.bySemanticsLabel()` only matches the `label` property of a `SemanticsNode` — it never matches `identifier`.

**Diagnosis:** Check the design-system button's source for which `Semantics` property it actually populates:

```dart
return Semantics(
  container: true,
  button: true,
  identifier: widget.semantics,  // ← identifier, not label
  enabled: widget.enabled,
  child: _InputPadding(...),
);
```

**Fix:** Use `find.byWidgetPredicate` to match on the `identifier` field, then wrap it for Patrol:

```dart
// BEFORE (broken — bySemanticsLabel never matches identifier)
find.bySemanticsLabel('confirm_button')    // always 0 widgets

// AFTER (fixed)
final confirmFinder = find.byWidgetPredicate(
  (widget) =>
      widget is Semantics &&
      widget.properties.identifier == 'confirm_button',
);
await $(confirmFinder).tap(settlePolicy: SettlePolicy.noSettle);
```

---

## Pattern 4 — `$.tester.tap()` queues a tap but never flushes it <!-- 25 -->

**Error:** Tap appears to succeed (no exception thrown) but the button callback is never invoked. Navigation does not happen after the tap.

**Root cause:** `$.tester.tap()` (`WidgetTester.tap()`) only enqueues the gesture event in the test engine's event queue. It does NOT pump the frame. Without a subsequent `$.pump()`, the Flutter framework never processes the gesture and the `InkWell.onTap` / `onPressed` callback is never called.

**Diagnosis:** The tap returns without error but the expected navigation/state change never occurs. `native-tree` after the "tap" shows the screen is unchanged.

**Fix:** Either use Patrol's `$(finder).tap()` (which pumps internally), or follow a raw `$.tester.tap()` with an explicit pump:

```dart
// BEFORE (broken — tap queued but never flushed)
await $.tester.tap(someFinder.first);
// navigation never happens

// AFTER option A — use PatrolFinder.tap() which pumps automatically
await $(someFinder).tap(settlePolicy: SettlePolicy.noSettle);

// AFTER option B — explicit pump after raw tester.tap()
await $.tester.tap(someFinder.first);
await $.pump(const Duration(milliseconds: 500));
```

---

## Pattern 5 — Locale-dependent text selectors break on a different device locale <!-- 43 -->

**Error:**
```
find.text('Home') — 0 widgets  (device running a different locale than assumed)
find.text('Continue') — 0 widgets
```
Test never reaches the expected screen; a subsequent assertion fails.

**Root cause:** Localized strings (`context.l10n.*`, `AppLocalizations.of(context)`) resolve in the **device locale**, not the locale the test author assumed. On a device set to a different locale than expected, every ARB-backed string resolves to a different literal value than the one hardcoded in the test.

**Diagnosis:** Dump all `Text` widgets currently on screen to compare against the expected literal:

```dart
final allTexts = find.byType(Text).evaluate().map((e) {
  final w = e.widget as Text;
  return w.data ?? w.textSpan?.toPlainText() ?? '';
}).where((s) => s.isNotEmpty).toList();
print('[DIAG] Texts on screen: $allTexts');
```
If the printed strings are in an unexpected language, the device locale differs from what the test assumed.

**Fix:** Prefer **locale-independent** selectors:

1. **Semantics identifier** — set via the design system's button/element `semantics:` parameter; locale-invariant.
2. **Hardcoded Semantics label** — e.g. a brand logo using `Semantics(label: 'App Name', image: true)` — not a localized string.
3. **Widget Key** — `Key('confirm_button')` if available.

```dart
// BEFORE (broken — locale-dependent)
$('Home').exists || $('Continue').exists

// AFTER (fixed — locale-independent alternatives)
$('App Name').exists  // brand logo Semantics.label, always present regardless of locale
find.byWidgetPredicate(
  (widget) =>
      widget is Semantics &&
      widget.properties.identifier == 'confirm_button',
).evaluate().isNotEmpty  // Semantics.identifier, also locale-invariant
```

---

## Pattern 6 — Identity-provider rate-limiting rejects consecutive login attempts (ENVIRONMENTAL) <!-- 12 -->

**Symptom:** After tapping a native "Sign in" button in an SSO/OAuth WebView, the WebView reloads the same sign-in URL instead of redirecting to the OAuth callback. The expected post-login screen never appears; the test's timeout is exhausted.

**Root cause:** The identity provider (OAuth/SSO server) rate-limits consecutive login attempts from the same client within a short window (commonly several minutes). A second attempt run too soon after the first gets the sign-in page again instead of the OAuth redirect.

**Diagnosis:** Watch the WebView URL via `native-tree`. If it stays on the sign-in URL after the "Sign in" button is tapped, the server rejected the attempt — this is not a selector or timing bug in the test.

**Fix:** **Environmental — cannot be fixed in test code.** Space test runs at least several minutes apart against the same identity-provider tenant. For CI, add a mandatory delay between successive SSO-login test runs, or use a dedicated test account pool to avoid contention. This is the canonical example of a failure that is correctly diagnosed but not fixable by editing the Dart test — report it and stop rather than attempting workarounds that mask a real environmental constraint.

---

## Pattern 7 — `$('text')` does not match `Semantics.label` — only matches `Text` widgets <!-- 26 -->

**Error:**
```dart
// Returns 0 elements even though Semantics(label: 'App Name') is on screen
$('App Name').exists  // false
```

**Root cause:** Patrol's `$(matching)` operator converts a String via `createFinder(matching)` → `find.text(matching, findRichText: true)`. This searches for actual `Text` (and `RichText`) widgets in the widget tree — it does NOT query the semantics tree. A widget like `Semantics(label: 'App Name', image: true, child: SvgPicture.asset(...))` wraps an image with no `Text` widget in its subtree, so `find.text('App Name')` finds nothing even though a semantics node with that label is present.

**Diagnosis:** If an element is a `Semantics(label: ...)` wrapping a non-text widget (Icon, SvgPicture, Image, etc.), `$('label_text').exists` will always return false — regardless of what's visually on screen.

**Fix:** Use `find.bySemanticsLabel(pattern)`, which walks the semantics tree and matches `SemanticsNode.label`:

```dart
// BEFORE (broken — searches Text widget tree, misses Semantics label)
$('App Name').exists

// AFTER (fixed — queries the semantics tree directly)
find.bySemanticsLabel('App Name').evaluate().isNotEmpty
```

`find.bySemanticsLabel` accepts a `Pattern` (String or RegExp) — use a String for exact match, RegExp for partial. Note the inverse also holds: `find.bySemanticsLabel` does NOT find `Semantics.identifier` values, only `Semantics.label`. For identifier-based lookup, use `find.byWidgetPredicate((w) => w is Semantics && w.properties.identifier == '...')` (see Pattern 3).

---

## Pattern 8 — `$.pump(Duration)` does not advance real wall-clock time; a WebView redirect times out <!-- 54 -->

**Error:**
```
Exception: Expected screen did not appear within 90 s after login redirect
```

**Root cause:** `$.pump(const Duration(seconds: 1))` in a Patrol integration test drives the Flutter scheduler clock forward — it does NOT block for a real second of wall-clock time. A loop of `for (var i = 0; i < 90; i++) { await $.pump(const Duration(seconds: 1)); }` can complete in milliseconds of real time while advancing the *simulated* scheduler by 90 s. A WebView-based login/OAuth round trip needs **real wall-clock time** (network latency + server processing) — if the pump loop exhausts before the platform channel delivers the redirect result, the detection window closes before the app has actually navigated.

**Diagnosis:** After tapping the native "Sign in" button (via `$.native.tap()`), platform logs show no further app activity (no auth-module response, no post-login navigation) until the Dart test throws its timeout exception. The WebView is still processing the redirect in native space while the Flutter pump loop runs dry.

**Fix:** Replace the post-redirect Flutter pump loop with `$.native.waitUntilVisible()`, which blocks on real wall-clock time via the platform's native "wait for" primitive. Even when the target element is not found (the call throws), the failed attempt itself consumes real time, allowing the redirect to finish processing in the background:

```dart
// BEFORE (broken — pump loop exhausts before the redirect completes)
var screenReady = false;
for (var i = 0; i < 90; i++) {
  await $.pump(const Duration(seconds: 1));  // NOT real wall-clock time!
  if (_targetScreenFinder().evaluate().isNotEmpty) {
    screenReady = true;
    break;
  }
}
if (!screenReady) throw Exception('Expected screen did not appear...');

// AFTER (fixed — native waits block on real wall-clock time)
var screenReady = false;
final nativeAnchors = <(String, Duration)>[
  ('Home', const Duration(seconds: 120)),      // primary locale title: wait up to 120 s
  ('Beranda', const Duration(seconds: 2)),     // secondary locale title, short fallback check
];
for (final (anchor, timeout) in nativeAnchors) {
  try {
    await $.native.waitUntilVisible(Selector(text: anchor), timeout: timeout);
    screenReady = true;
    break;
  } catch (_) {}
}
// Flutter pump fallback if native anchors not found (unknown locale)
if (!screenReady) {
  for (var i = 0; i < 30; i++) {
    await $.pump(const Duration(seconds: 1));
    if (_targetScreenFinder().evaluate().isNotEmpty) {
      screenReady = true;
      break;
    }
  }
}
```

**Key insight:** even FAILED `$.native.waitUntilVisible()` calls consume real wall-clock time. A sequence of several anchor attempts totaling ~9–11 s of real time is often enough for a redirect/token exchange to complete. By the time the Flutter pump fallback runs, the target screen is already rendered and the widget-tree check succeeds immediately.

---

## Pattern 9 — WebView form does not submit after `$.native.enterText()` — native `setText()` bypasses JS input events <!-- 50 -->

**Symptom:** After `$.native.enterText()` fills both fields of a JS-framework-controlled WebView form (React, Vue, etc.), the visible text is correct but tapping the submit button has no effect. The form stays on screen until the post-submit wait times out.

**Root cause:** `$.native.enterText()` calls the platform automation server, which issues a native `setText()` call. On Android this dispatches the `ACTION_SET_TEXT` accessibility action — it sets the `EditText` buffer directly **without** going through the `InputConnection` bridge, which is the channel the platform keyboard normally uses to send `KeyEvent`s into a WebView's JS engine. With `ACTION_SET_TEXT`, the browser's DOM value is set visually but no `input`, `change`, or `blur` DOM events fire. A JS framework's controlled-input state (maintained via synthetic event listeners) never receives an update and stays at its initial empty value. The submit handler reads that state, sees empty fields, and silently rejects the submission.

**Diagnosis:** both fields appear filled with the correct values in the native tree/screenshot; the submit button is tapped with no error, but the form stays visible; the post-submit wait times out with no token exchange or follow-up network call; `native-tree`/UI-tree dumps are blind to WebView HTML content, so they cannot diagnose deeper inside the form itself.

**Fix:** After each `$.native.enterText()` on a WebView field, inject a TAB key event via the platform's native input-injection binary, run **from within the Dart test process on-device**. TAB is delivered through the `InputConnection`, which the WebView relays to the JS engine as a real keyboard event — firing the framework's `onBlur`/`onChange` listeners and syncing its controlled-input state to the actual DOM value. After both fields are synced, inject ENTER to submit via keyboard, falling back to a native tap if the button is still visible.

**Critical implementation note:** the injection call runs *inside the device's own process*, not on the host machine — there is no host CLI binary available on-device. Use the on-device input binary directly (e.g. Android's `/system/bin/input`, present on all Android 5+ devices):

```dart
// WRONG — a host-side CLI binary does not exist on the device
await Process.run('adb', ['-s', 'emulator-5554', 'shell', 'input', 'keyevent', '61']);
// Throws: ProcessException: Permission denied

// CORRECT — inject keys via the on-device input binary, then confirm via keyboard
Future<void> deviceKey(int keyCode) async {
  await Process.run('/system/bin/input', ['keyevent', '$keyCode']);
  await $.pump(const Duration(milliseconds: 300));
}

Future<void> fillWebViewField(int instance, String value) async {
  final field = Selector(className: 'android.widget.EditText', instance: instance);
  await $.native.tap(field);
  await $.native.enterText(field, text: value);
  await deviceKey(61); // KEYCODE_TAB — blurs the field, framework syncs its state
}

await fillWebViewField(0, email);
await fillWebViewField(1, password);
await $.pump(const Duration(milliseconds: 500));

// Submit — try Enter first (fires onClick on the focused button), then fall back to a tap
await deviceKey(66); // KEYCODE_ENTER
await $.pump(const Duration(seconds: 1));
final submitBtn = Selector(className: 'android.widget.Button', text: 'Sign in');
try {
  await $.native.waitUntilVisible(submitBtn, timeout: const Duration(seconds: 2));
  await $.native.tap(submitBtn); // still visible — Enter didn't submit
} catch (_) {
  // Button gone — form submitted successfully
}
```

**Key keycode values:** `61` = TAB (moves focus, fires blur/change on the current field); `66` = ENTER (activates the focused button/field).

---

## Pattern 10 — Zero-match `PatrolFinder.tap()` hangs indefinitely <!-- 29 -->

**Symptom:** The test run stalls completely at a specific step (e.g. "tap a chip labeled 'Last 7 days'"). No timeout, no exception — the test simply never advances. The step counter freezes; killing the host process is the only recovery.

**Root cause:** `PatrolFinder.tap()` calls `waitUntilVisible()` on the finder before tapping. `waitUntilVisible()` polls indefinitely (no default timeout) waiting for the finder to produce at least one match. If the finder has **zero matches** — because the element is data-dependent, conditionally rendered, or uses an unexpected locale label — the call blocks forever. A locale-fallback helper that returns one locale's finder as a default (even when neither locale's label is present) makes this easy to trigger silently: calling `.tap()` on that fallback finder hangs even though nothing is actually on screen.

**Diagnosis:** `native-tree` immediately before the hang shows the element is absent from the tree; a locale-fallback helper returned a default finder (verify presence with an explicit `.exists` check, independent of the helper); the step trace counter freezes exactly at the `.tap()` call line.

**Fix:** Always guard any `.tap()` call with an `.exists` (or equivalent existence) check first. Skipping is always preferable to hanging:

```dart
// BEFORE (broken — hangs if neither locale label is present)
await t($, 'Last 7 days', '7 hari terakhir')
    .tap(settlePolicy: SettlePolicy.noSettle);

// AFTER (fixed — skip gracefully instead of hanging)
if (existsEnId($, 'Last 7 days', '7 hari terakhir')) {
  await t($, 'Last 7 days', '7 hari terakhir')
      .tap(settlePolicy: SettlePolicy.noSettle);
  // ... assert post-tap state
} else {
  c.skip('RET-004', 'date-range chip not present after load');
}
```

**General rule:** never call `.tap()` on a finder without a prior existence check. Use `.exists` / `finder.evaluate().isNotEmpty` as the guard.

---

## Pattern 11 — `scrollTo()` + immediate tap: scroll animation not yet settled <!-- 35 -->

**Symptom:**
```
TimeoutException: Finder "Found 1 widget with text 'Printer'" did not find any
visible (i.e. hit-testable) widgets
```
The widget is in the tree (found by text), `scrollTo()` is called, but the subsequent `.tap()` fails with a hit-testable timeout. The widget appears scrolled into view, but Patrol's internal `waitUntilVisible()` inside `.tap()` cannot confirm it is hit-testable.

**Root cause:** `scrollTo()` initiates a scroll animation but returns before the animation completes. A short fixed pump (e.g. 300 ms) after `scrollTo()` is often not long enough for a `SingleChildScrollView`/`ListView` animation to finish settling. The widget is still in an intermediate position and does not yet pass the hit-test — either partially occluded or with layout not yet finalized.

**Diagnosis:** the widget's text is found in the tree (`.evaluate().isNotEmpty`); `scrollTo()` does not throw (a scrollable ancestor exists); `.tap()` immediately after the scroll fails with a hit-testable timeout.

**Fix:** Replace a short fixed pump after `scrollTo()` with `$.pumpAndSettle(duration: ...)` to wait for the scroll animation to fully complete before tapping:

```dart
// BEFORE (broken — scroll animation may not be complete)
try {
  await f.scrollTo();
  await $.pump(const Duration(milliseconds: 300));
} catch (_) { /* ... */ }
await f.first.tap(settlePolicy: SettlePolicy.noSettle);

// AFTER (fixed — wait for scroll to settle before tapping)
try {
  await f.scrollTo();
  await $.pumpAndSettle(duration: const Duration(milliseconds: 500));
} catch (_) {
  await $.pump(const Duration(milliseconds: 300));  // fallback if no scrollable
}
await f.first.tap(settlePolicy: SettlePolicy.noSettle);
```

---

## Pattern 12 — Stale widget count causes `RangeError` after the tree is rebuilt mid-loop <!-- 37 -->

**Symptom:**
```
RangeError (index): Index out of range: index should be less than 20: 22
```
A loop taps `find.byType(InkWell).at(idx)` where `idx` was derived from a `count` captured before the loop. After a navigation inside the loop body, the widget tree rebuilds with a different number of matching widgets. The stale `count` now produces an out-of-range index against the refreshed tree.

**Root cause:** `final count = find.byType(InkWell).evaluate().length` captures the list length at one point in time. If the loop body navigates away and back, the tree rebuilds and `find.byType(InkWell).evaluate().length` changes. Indexing with the old `count` accesses a position that no longer exists in the new tree.

**Diagnosis:** the crash occurs immediately after a navigation inside the loop body; the error's requested index corresponds to the original `count` minus one; the actual tree length (the RangeError's upper bound) is smaller than the captured `count`.

**Fix:** Re-evaluate the live element count on every loop iteration. Use a relative offset (e.g. `-1` for "last") instead of a pre-captured absolute index:

```dart
// BEFORE (broken — stale count causes RangeError after tree rebuild)
final count = find.byType(InkWell).evaluate().length;
for (final idx in <int>[2, 3, 4, count - 1]) {
  if (idx < 2 || idx >= count) continue;
  await $.tester.tap(find.byType(InkWell).at(idx));
  // ... navigate and come back
}

// AFTER (fixed — re-evaluate count each iteration; use relative offset for last)
for (final candidateOffset in <int>[2, 3, 4, -1]) {
  final currentCount = find.byType(InkWell).evaluate().length;
  final idx = candidateOffset >= 0
      ? candidateOffset
      : currentCount + candidateOffset;  // -1 → last element
  if (idx < 2 || idx >= currentCount) continue;
  await $.tester.tap(find.byType(InkWell).at(idx));
  // ... navigate and come back (currentCount re-evaluated next iteration)
}
```

---

## Pattern 13 — `Scrollable.ensureVisible` hangs indefinitely on an offstage `IndexedStack` child <!-- 30 -->

**Symptom:** The suite appears permanently stuck on a screen with no test progress and no error thrown. The step counter freezes. The test never times out.

**Root cause:** `IndexedStack` wraps each non-active child in `Offstage(offstage: true)` and `TickerMode(enabled: false)`. When a scroll-to-element helper calls `Scrollable.ensureVisible(element, duration: ...)` on an element from an inactive (offstage) `IndexedStack` fragment, the internal `ScrollPosition.animateTo()` creates an `AnimationController` whose `Ticker` is disabled by `TickerMode` — the animation never advances, and the `Future<void>` it returns never completes. This is easy to trigger because `find.text(...)` matches `Text` widgets from ALL `IndexedStack` children, including inactive ones: if the caller is actually on a different tab, a wait-then-proceed helper can find the target text in an offstage fragment and proceed as if the intended tab were active.

**Diagnosis:** `native-tree` shows the app on a screen that is NOT the one the step trace claims to be scrolling on, but the step counter is frozen at `scrollTo`/`ensureVisible`; no exception is thrown — the hang is silent; the test is awaiting a scroll-animation `Future` that never resolves because its `Ticker` is disabled.

**Fix:** Wrap the `Scrollable.ensureVisible` call with `.timeout(...)` and a no-op `onTimeout`. The no-op prevents an exception; the caller's existing error handling covers any fallback pumping. This bounds the wait even when the `Ticker` is disabled:

```dart
// BEFORE (broken — hangs indefinitely on an offstage element)
await Scrollable.ensureVisible(
  elements.first,
  duration: const Duration(milliseconds: 400),
  curve: Curves.easeInOut,
);

// AFTER (fixed — bounded wait, no-op on timeout)
await Scrollable.ensureVisible(
  elements.first,
  duration: const Duration(milliseconds: 400),
  curve: Curves.easeInOut,
).timeout(const Duration(seconds: 2), onTimeout: () {});
```

**Additional defence:** keep any surrounding navigation helper's own timeout modest (e.g. tens of seconds, not minutes). With `Scrollable.ensureVisible` now bounded, a secondary cap prevents a multi-minute block in the rare case where a nav label is temporarily not hit-testable.

---

## Pattern 14 — Unconditional `pressBack()` on the home screen backgrounds the app and hangs the test <!-- 25 -->

**Symptom:** The test hangs indefinitely mid-run with no steps logged after a `pressBack` call. Platform logs show the app was backgrounded immediately after the pressBack. The Patrol gRPC channel drops (the Patrol server runs inside the app process), and the Dart test client waits forever for a response that never comes.

**Root cause:** A `$.native.pressBack()` call fired when the app was already on the OS home shell (no dialog, sheet, or pushed route to dismiss). The platform interprets the back press as a request to background the app — equivalent to the user pressing the home button. The Patrol server, running inside the now-backgrounded app process, is suspended. The Dart test client is still waiting for the pressBack call to return, but the server never responds — the test freezes.

**Diagnosis:** platform logs show the app was backgrounded immediately after the pressBack call; the automation server logs the pressBack request but no subsequent app-side log line; the step trace shows pressBack starting but never completing; the test process is still alive but sleeping indefinitely.

**Fix:** Never call `$.native.pressBack()` unconditionally when the app might already be on the home screen. Always guard back presses behind a check that a dismissible overlay/route is actually present:

```dart
// BEFORE (broken — unconditional pressBack backgrounds the app when already on home)
try { await $.native.pressBack(); } catch (_) {}

// AFTER (fixed — only back-press when NOT already on the home screen)
for (var k = 0; k < 5 && !isOnHomeScreen($); k++) {
  try { await $.native.pressBack(); } catch (_) {}
  await $.pump(const Duration(seconds: 1));
}
```

**Key rule:** whenever a `pressBack` is needed to dismiss a known open dialog/sheet, call it inside the scenario with a specific condition (`if (dialogOpen) { pressBack(); }`) rather than in a generic recovery wrapper. A generic recovery wrapper cannot safely fire an unconditional back press because it runs regardless of the app's current state — and firing one while already on the home screen is what triggers this hang.

---

## Pattern 15 — `pumpUntil` cannot wait for a real HTTP response <!-- 62 -->

**Symptom:** A `pumpUntil(maxSeconds: N)` call returns `false` even with a generous `N` (8–20 simulated seconds), so the following assertion fails. The condition checks a widget populated by a BLoC/Cubit response (a list loading, a gated action becoming available after a state refresh) — the widget never appears in the composed run, even though it eventually does when the same test runs standalone.

**Root cause:** `pumpUntil` iterates `$.pump(const Duration(seconds: 1))` N times. As established in Pattern 8, `$.pump(Duration)` advances only the Flutter **scheduler clock** — it does NOT consume real wall-clock time. When the awaited condition depends on a real HTTP round trip, the N simulated-second iterations pass with essentially zero real time elapsed; the API call never resolves within the loop, and the BLoC/Cubit never emits the loaded state. The condition stays false for all N iterations regardless of how large N is. This is compounded in a composed/chained test suite: each scenario may need a fresh HTTP call, but consecutive scenarios are separated only by Flutter pump cycles, not by real time.

**Diagnosis:** the failing assertion is guarded by `pumpUntil(maxSeconds: N)`; running the same testcase standalone passes, because app bootstrap/login naturally burns some real time before the check runs; increasing `maxSeconds` does not help — the issue is wall-clock time, not simulated ticks.

**Fix:** Replace `pumpUntil` with a `pumpUntilReal` helper that burns real wall-clock time between checks by issuing native dummy-selector waits (which block on real time even when they fail):

```dart
/// Like pumpUntil but burns REAL wall-clock time between checks via native calls.
Future<bool> pumpUntilReal(
  PatrolIntegrationTester $,
  bool Function() ready, {
  int maxSeconds = 20,
  int realBurnMs = 2000,
}) async {
  final iterations = (maxSeconds * 1000 / realBurnMs).ceil();
  for (var i = 0; i < iterations; i++) {
    await $.pump(const Duration(milliseconds: 100));
    if (ready()) return true;
    try {
      await $.native.waitUntilVisible(
        Selector(text: '__pumpUntilReal_dummy__'),
        timeout: Duration(milliseconds: realBurnMs),
      );
    } catch (_) {
      // Expected — dummy selector never matches. realBurnMs real time consumed.
    }
    await $.pump(const Duration(milliseconds: 100));
    if (ready()) return true;
  }
  return ready();
}
```

Usage in place of `pumpUntil` for HTTP-backed conditions:

```dart
// BEFORE (broken — $.pump does not consume real time; the BLoC never gets an HTTP response)
final ready = await pumpUntil(
  $,
  () => bySemId('primary_gated_action').evaluate().isNotEmpty,
  maxSeconds: 8,
);

// AFTER (fixed — burns real seconds between checks)
final ready = await pumpUntilReal(
  $,
  () => bySemId('primary_gated_action').evaluate().isNotEmpty,
  maxSeconds: 20,
  realBurnMs: 2000,
);
```

**When to use `pumpUntilReal` vs `pumpUntil`:**
- `pumpUntil` — for conditions that are pure Flutter widget-tree state (animation complete, dialog dismissed, widget rebuilt from synchronous local state). These advance with `$.pump`.
- `pumpUntilReal` — for conditions that depend on a real HTTP API response, a BLoC/Cubit that makes a network call in `initState`, or any condition that passes standalone (because app bootstrap takes real time) but fails when chained directly after another scenario (because no real time passes in between).

---

## Pattern 16 — Injected mock error never renders error UI (cache-fallback trap) <!-- 26 -->

**Symptom:** An error/latency injection test arranges an override via `MockControl` (`stubErrorBody`/`stubBody`) and the run completes without exception, but the expected error UI (banner, error state, retry prompt) never appears — the screen instead shows normal-looking data, as if the request had succeeded.

**Root cause:** An offline-first repository serves cached data when a request fails, instead of surfacing the failure to the UI. The mock server correctly returned the injected error — the override did fire — but the repository's cache-fallback branch swallowed it before it ever reached the presentation layer. The test setup isn't wrong; the endpoint chosen for injection simply has no observable failure path.

**Diagnosis:** Check the mock server's request log for the endpoint — the override entry fired (status code and body match the injected error):

```
[mock-server] GET /api/v1/orders -> override (500) matched, uses remaining: 0
```

Then check the repository's failure branch for that endpoint: if it has a cache/local-fallback path, the UI legitimately never sees the failure, regardless of how correctly the mock injected it.

**Fix:** Pick a different endpoint (or case) whose repository has no cache fallback and genuinely propagates the failure to the UI, and tag the resulting test `mockonly` since it only exercises via error injection:

```dart
// BEFORE — endpoint's repository caches on failure; error never reaches the UI
await mock.stubErrorBody('/api/v1/orders', status: 500);

// AFTER — endpoint verified to have no cache fallback; failure surfaces
await mock.stubErrorBody('/api/v1/inventory/sync', status: 500);
```

---

## Pattern 17 — App boots to a black screen / crashes, or requests hit connection-refused at startup in mock mode <!-- 23 -->

**Symptom:** In a mock-mode run, the app either shows a black screen and closes immediately, or its very first network request throws `Connection refused`/`SocketException` before any UI renders.

**Root cause:** Boot-ordering violation — `app.main()` started before the mock server was listening. The app's startup sequence issued its first HTTP call (or bootstrap fetch) against a loopback port with nothing bound to it yet.

**Diagnosis:** Compare the `[mock-server]` "listening" log line's timestamp against the app's first request. If the request has no preceding server-listening log — or precedes it — the launch helper started the app too early.

**Fix:** In the launch helper (`launchApp($)`), await the server-listening future, then seed the session, then call `app.main()` — never reorder this sequence:

```dart
// BEFORE (broken — app starts before the server is confirmed listening)
unawaited(startMockServer());
app.main();

// AFTER (fixed — strict boot order)
await startMockServer();       // await server listening
await seedMockSession();       // seed session
app.main();                    // start app last
```

---

## Pattern 18 — `Connection refused` / `SocketException` on loopback mid-run <!-- 12 -->

**Symptom:** Mid-test (not at startup), a request suddenly throws `Connection refused`/`SocketException` against a loopback address, even though earlier requests in the same run succeeded.

**Root cause:** Env-seam misfire — the app's base URL was never flipped to the mock loopback address for this scenario (it's still pointing at the real backend or a different port), or the mock server was never started for this particular scenario/process.

**Diagnosis:** Compare the app's configured base URL (via its env/flavor mechanism) against the `[mock-server]` log's bound port for this run. A mismatch — wrong port, or no `[mock-server]` log at all for this scenario — confirms the seam misfired rather than an actual network issue.

**Fix:** Confirm the mock-env define (e.g. `--dart-define=ENV=MOCK`) is passed for every scenario in the run, and that the base-URL seam re-reads it per scenario rather than caching a previous scenario's config.

---

## Pattern 19 — Test run hangs between scenarios, or the device is stuck after a mock test <!-- 20 -->

**Symptom:** The suite stalls between scenarios with no timeout and no error, or the device/emulator remains unresponsive after a mock-mode test completes.

**Root cause:** Missing or failed `tearDown(stopMockServer)`. The mock server's socket is still open, which keeps the test isolate alive — the process never exits cleanly, so the next scenario (or the harness itself) never regains control.

**Diagnosis:** Check whether the suite registers `tearDown(stopMockServer)` at all, and whether it actually completes — a `stopMockServer` that awaits pending connections indefinitely has the same effect as omitting it entirely.

**Fix:** Ensure every mock-mode test file registers `tearDown(stopMockServer)`, and that `stopMockServer` force-closes the socket rather than waiting for a graceful drain:

```dart
// BEFORE (broken — no teardown, or a graceful shutdown that never completes)
setUp(resetMockServerState);
// no tearDown — socket stays open, isolate never exits

// AFTER (fixed — load-bearing teardown, forceful close)
setUpAll(clearAppData);
setUp(resetMockServerState);
tearDown(stopMockServer); // forceful close — do not await graceful drain
```
