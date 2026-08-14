# Patrol Selector Rules

> Related: patrol-standard.md, patrol-failure-patterns.md

The single source of truth for Patrol selector strategy across all QA agents and skills. Referenced by Rule 2 and Rule 3 of `patrol-standard.md` — do not duplicate this content elsewhere, point to it.

## Selector Priority Hierarchy

Before writing any selector, gather context from:

1. **Live UI tree** — `mcp__patrol__native-tree` for runtime element identifiers/text/states.
2. **Screen source code** — read the Flutter screen file for widget keys (`Key('...')`), `Semantics(identifier: '...')`, and stable string constants.

Then follow this priority order.

### 1. Text selector (highest priority)

Element has visible, stable text:

```dart
await $('Login').tap();
expect($('Welcome'), findsOneWidget);
```

### 2. Semantic identifier / Key

Element has no visible text but has a Key or Semantics identifier:

```dart
await $(#emailField).tap();
await $(#emailField).enterText('test@example.com');
```

**Flutter Semantics rule:** always pair `identifier:` with `container: true`. Without `container: true`, the widget's children are not exposed to the accessibility tree as a single addressable node:

```dart
Semantics(
  identifier: 'widget_name',
  container: true,
  child: YourWidget(),
)
```

### 3. Widget type + ancestor chaining (when duplicate text exists)

When the same text appears multiple times (e.g. a header and a button with the same label), use ancestor chaining to disambiguate:

```dart
// Finds 'Submit' text inside a Scaffold descendant
await $(Scaffold).$('Submit').tap();

// Or use a more specific parent
await $(#formSection).$('Submit').tap();
```

### 4. Relative positioning / `containing` finder (last resort before a code change)

```dart
// Find 'Submit' that is a descendant of the Terms section
await $('Terms and Conditions').$('Submit').tap();

// Or use containing to filter by descendant widgets
await $(Scrollable).containing($('Submit')).tap();
```

### 5. Add Semantics (when nothing else works)

If no selector works, add `Semantics(identifier: 'widget_key', container: true)` to the Flutter widget, rebuild, and use the `$(#widget_key)` selector.

**NEVER use `$.native.tap(Offset(x, y))` with coordinates** — they break across screen sizes and pixel densities. If a coordinate-based tap exists in a file and is failing, replace it first, before investigating anything else.

---

## Accessibility Node Merging

Flutter widgets that render a label + value inside a `Row` often merge into a single accessibility node:

```
Field label
Field value
```

**Fix in Patrol:** use the `containing` finder, or match the full merged text:

```dart
// WRONG — exact text match may fail on a merged node
expect($('Field label'), findsOneWidget);

// CORRECT — use containing to find the parent row
expect($(Row).containing($('Field label')), findsOneWidget);

// Or wait for the merged text directly
await $('Field label Field value').waitUntilVisible();
```

**Route prefix merging:** parent containers may emit a combined text that includes the screen route plus all child values in the native tree. Scope the search with a more specific finder:

```dart
// WRONG — text doesn't start with the label
expect($('Section heading'), findsOneWidget);

// CORRECT — scope with ancestor chaining
await $(#sectionContainer).$('Section heading').tap();
```

**Detection:** use `mcp__patrol__native-tree` and check the element's `text` or `label` field. If it contains extra content beyond the expected label, use ancestor chaining or `containing` to disambiguate. **Never use screenshots for selector investigation** — the native tree provides exact text, identifiers, and hierarchy without ambiguity.

---

## Selector Decision Tree

```
native-tree element has text content (non-empty)?
  YES → use $('exact_text').tap()
  NO  → has resource-id / key?
        YES → use $(#keyOrId).tap()
        NO  → has a Semantics identifier?
              YES → use $(#semanticsIdentifier).tap()
              NO  → same text appears multiple times?
                    YES → use ancestor chaining: $(Parent).$('text').tap()
                    NO  → add Semantics(identifier: 'name', container: true)
                          rebuild app, then use $(#name).tap()
```

---

## Timeout Conventions

| Situation | Approach |
|---|---|
| Wait for element to appear | `$('text').waitUntilVisible(timeout: Duration(seconds: 5))` |
| Wait for animations to settle | `await $.pumpWidgetAndSettle()` |
| Custom timeout for slow transitions | `$('text').waitUntilVisible(timeout: Duration(seconds: 10))` |

Patrol's `pumpWidgetAndSettle()` handles most animation settling automatically. Use `waitUntilVisible()` for elements that take time to appear (network loads, page transitions).

---

## Rebuild Requirement

After adding `Semantics` or making any Flutter source change:

1. Rebuild the app (`flutter build`).
2. Reinstall on the device/emulator.
3. Only then re-run Patrol tests.

Patrol tests the **compiled binary** (APK/IPA), not the source code. Changes — including new `Semantics` — are not reflected until you rebuild and reinstall.
