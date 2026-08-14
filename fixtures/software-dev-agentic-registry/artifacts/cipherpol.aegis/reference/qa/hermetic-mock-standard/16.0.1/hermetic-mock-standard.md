# Hermetic Mock Backend Standard

> Related: patrol-standard.md, qa-gates.md, patrol-failure-patterns.md, qa-mock-worker.md
> Doctrine (the "why"): https://jurnal.atlassian.net/wiki/spaces/MOBI/pages/51254788102

The authoritative standard for generating and extending a **hermetic mock backend** in a downstream Flutter app — a deterministic, network-free in-process HTTP server that lets Patrol UI automation run against frozen fixtures instead of a live backend. Covers the two production seams, the response-resolution pipeline, the fixture model, the arrange facade, boot ordering, lifecycle, the honesty gates, canonical paths, and mock-aware Patrol authoring.

## Authority Rule <!-- 4 -->

**This document wins.** When any QA persona work scaffolds, extends, or reasons about a hermetic mock backend, the structure, contracts, and rules defined here are authoritative. Ignore whatever mock/stub patterns already exist in the downstream repo (`http_mock_adapter`, a Dio interceptor, bundled asset fixtures, an ad-hoc local server) — legacy approaches are not a precedent. If an existing file conflicts with this standard, the existing file is wrong, not this document. The one thing you never override is a **discovered app fact** (§Discovery) — those are read from the target repo, never invented.

## Discovery Rule (read before every template) <!-- 22 -->

Every template in this document is a **generalized Dart/JSON skeleton**. It contains `<DISCOVERED: …>` placeholders. Each placeholder is an app-specific fact the worker MUST read out of the target repo before writing a single line — **never guess, never fabricate.** If a placeholder value cannot be discovered, STOP and ask; do not fall back to a mekaripos value or a plausible default.

| Placeholder | What it is | Infer via | Ask only if |
|---|---|---|---|
| `<DISCOVERED: port>` | Loopback port the server binds | **Scaffold:** pick a free high port; confirm unused. **Extend:** do NOT pick a new port — read and reuse the existing bound port from `mock_server.dart` (grep the port literal / the `InternetAddress.loopbackIPv4` bind call) | port conflict (scaffold mode) |
| `<DISCOVERED: env flag>` | Build/run selector for mock env (e.g. an `ENV`/flavor dart-define) | Grep `envied` / `String.fromEnvironment` / `.env*` / flavor configs | no recognizable mechanism |
| `<DISCOVERED: isMock check>` | The boolean the app exposes for "am I in mock env" | the env-config class found above | mechanism unclear |
| `<DISCOVERED: base-url config>` | Where BASE_URL is selected per env | Grep `BASE_URL` / `baseUrl` / host constant | multiple hosts (multi-service) |
| `<DISCOVERED: api prefix>` | The path root(s) API calls share (e.g. `/api/v1`) — apps may have more than one; enumerate every distinct prefix in use, never assume a single global prefix | Grep the base-URL / route constants for every distinct prefix in use | a prefix's pattern is inconsistent or can't be confidently enumerated |
| `<DISCOVERED: http client>` | The HTTP client package | Grep `dio` / `package:http` / `Client(` | non-HTTP transport (gRPC → out of scope, STOP) |
| `<DISCOVERED: storage factory>` | The app's OWN credential-store factory | Grep `FlutterSecureStorage` / storage DI module | factory not locatable |
| `<DISCOVERED: session keys>` | Exact key names the app reads at cold boot | Grep the auth local data source `read(key:` / `write(key:` | keys obfuscated → ask for seed shape |
| `<DISCOVERED: app entrypoint>` | The `main()` the test calls to boot the app | Glob `lib/main*.dart` | multiple entrypoints |
| `<DISCOVERED: package name>` | The Dart package import prefix | read `pubspec.yaml` `name:` | — |
| `<DISCOVERED: clear-data cmd>` | How a fresh install state is forced per run | check `clearPackageData` / orchestrator config | not configured → surface as manual step |

> **Worked example (reference implementation — mekaripos-app).** These values are NOT defaults — they are one app's discovered facts, shown only to illustrate the shape: port `8089`; env flag `--dart-define=ENV=MOCK` via `envied`; `EnvConfig.isMock` / `EnvConfig.baseUrl`; api prefix `/app/v1`; `dio` client; `SecureStorageFactory.create()`; session keys `jwt_access_token` / `jwt_refresh_token` / `auth_user` / `active_outlet_id`; entrypoint `package:pos/main.dart`; clear-data `adb shell pm clear com.mekari.pos.dev`. Your target app's values will differ — discover them.

---

## 1. What a hermetic mock backend is <!-- 12 -->

**Platform-agnostic pattern.** A hermetic mock backend is a **Fake** (in the test-double taxonomy) run as a **hermetic** (self-contained, deterministic, network-cut) in-process HTTP server. The app under test makes **real HTTP calls over loopback** to it; nothing is stubbed inside the HTTP client. Every response is either a frozen fixture or a pure function of accumulated request state, so the same test yields the same result on every run. It is not a one-response-per-path stub — it is a small generic response engine (§3 pipeline + §5 taxonomy).

**Flutter / Patrol / shelf implementation stance.**
- The server is a `shelf` HTTP server **started in-process inside the Patrol test binary** (same Dart isolate as the test body), bound to `127.0.0.1:<DISCOVERED: port>`.
- The app makes real requests through its real `<DISCOVERED: http client>` — real serialization, interceptors, error mapping all execute exactly as in production.
- **Zero release footprint.** Server, fixtures, generated glue, and seed helpers live entirely under `integration_test/` (the test source set) and compile **only** into the test binary. Nothing ships in the release app.
- An unmocked request is a **hard failure, never a proxy** to a real backend.

---

## 2. The two production seams <!-- 23 -->

The app stays **mock-agnostic**: there is no mock branch, interceptor, or fixture in production code. Only **two seams** exist, both discovery-driven contracts.

### 2a. Base-URL flip contract

The mock environment is a **first-class build environment** — a peer of staging/production, selected by `<DISCOVERED: env flag>`. When selected, `<DISCOVERED: base-url config>` resolves BASE_URL to `http://127.0.0.1:<DISCOVERED: port>`. Release builds always select a non-mock env, so the mock env cannot ship accidentally.

- Do NOT add a mock-specific `if` inside the HTTP client — the flip lives in the existing env/config selection the app already has.
- Loopback cleartext `http`: most debug builds tolerate it; stricter platforms (iOS ATS) may need a loopback exception — validate per platform.

### 2b. Session-restore contract (programmatic authentication)

Login is delegated to an **external SSO / identity provider** that is out of the app's scope and cannot be faked in-process. So the mock env does not fake login — it **seeds the already-authenticated session** directly into the app's own credential store, and the app's ordinary cold-boot session restore routes straight past the login screen.

**Rules:**
- Write through the app's **OWN** `<DISCOVERED: storage factory>` — NOT a bare `FlutterSecureStorage()`. A bare instance uses different platform encryption options; the app then silently fails to find the seeded keys and still shows the login screen.
- Write the exact `<DISCOVERED: session keys>` the app reads at cold boot; seed identities MUST match the fixture bodies they represent (e.g. the user/tenant in `org_me`/`outlets`).
- **NEVER fake SSO.** No WebView, redirect, or token-issuance flow is simulated. (Token *refresh* against the app's own API *is* worth mocking — it drives the fail-once-then-succeed sequence, §5.)
- No real credentials or PII in seed values — synthetic identities only.

---

## 3. The response-resolution pipeline (the core) <!-- 31 -->

Every request flows through one handler as an **ordered, first-match-wins precedence chain**. Higher layers transparently shadow lower ones for the duration of a scenario. Route on **method + path only** (query string stripped); capture headers for assertions but never route on them. Keep at most **one** documented query-param exception (e.g. a search endpoint reading `q`).

| # | Stage | Purpose | Inputs | Invariant |
|---|---|---|---|---|
| ① | **Capture log** | Record the outgoing request so a scenario can assert on the payload, not just the response | method, path, query, redacted headers, parsed body | Recorded BEFORE anything is served; bounded FIFO; `Authorization` value redacted to `[present]` |
| ② | **Delay** | Open a deterministic loading-state window | registered delay entries (method + path-regex) | Sleeps before ANY source serves; matches at most one entry per request |
| ③ | **Overrides** | Per-scenario stubs — serve error/variant/empty/sequence on demand | override registry (method, path-regex, status, inline-body-or-fixture, optional `maxUses`) | Checked before everything below; on match with `maxUses`, decrement then auto-evict at 0 |
| ④ | **Stateful branches** | State-dependent status/body from in-memory state | accumulated per-scenario state + request | State is in-memory, reset per scenario; branch regex must stay consistent with any manifest entry for the same path |
| ⑤ | **Dynamic echo** | Synthesize a write response from the request body | request body (generated id, echoed fields) | Write endpoints only; may splice the synthesized entity into a later read |
| ⑥ | **Route table (manifest)** | The base allow-list — regex routes + read overlays + synthetic `/__mock__/` routes | manifest entries (method + path-regex, ordered) | First entry whose method equals AND path-regex matches wins; GET body may then be mutated by an overlay keyed on fixture identity |
| ⑦ | **Not-found (hard)** | Loud failure on an unmocked request | — | Returns a hard error status (e.g. **501**); **NEVER proxied** to a real backend |

**Every request logs exactly one line** naming the layer that resolved it (`OVERRIDE` / `STATE` / `ECHO` / `ROUTE` / `NOT-FOUND`) plus the status. The log is the ground truth when debugging which layer answered.

### 3b. Boundaries (out of scope by design)

The engine is generic, but it is still a **fixed allow-list driven by static values**. Do NOT build these — they belong in a real-backend integration test:

| Not simulated | Rule |
|---|---|
| Query filters / pagination | Query string is stripped for routing; keep at most one documented exception. Other page/filter params return the same body. |
| Path-id-specific bodies | A param route matches by regex shape only; the id does not select a distinct body unless a stateful/echo branch (④/⑤) reads it. |
| Full server-side business logic | Model the **minimum** state a scenario needs to observe an effect — never a second implementation of the backend. |
| Header-based routing | Headers are captured for assertions, never matched on. |
| Auth / SSO / login issuance | Bypassed via the seeded session (§2b), never faked. |
| Endpoints outside the route table | Only registered routes resolve; everything else is hard not-found. Add a fixture per not-found you observe in the log. |

---

## 4. The fixture & manifest model <!-- 29 -->

### 4a. Manifest schema

The route table is an **ordered JSON array**; each entry is one route:

```json
{ "method": "GET", "path": "^<DISCOVERED: api prefix>/orders$", "file": "orders.json", "status": 200 }
```

| Field | Rule |
|---|---|
| `method` | Required. Matched case-insensitively. |
| `path` | Required. A **regular expression** matched against the request path. Anchor with `^`. **Order matters** — list specific routes before broad prefixes (first-match-wins). |
| `file` | Required. Key of the fixture in the generated map (§4b). |
| `status` | Optional; defaults `200`. Lets a route serve a non-200 body directly. |

Regex covers the common shapes with no code: exact (`^/api/v1/orders$`), prefix (`^/api/v1/catalog`), path param (`^/api/v1/orders/[0-9a-f-]+$` — the id is not read; one shared fixture per shape, see §3b).

### 4b. Committed generated fixtures-map contract

Fixtures live as **source JSON** under `integration_test/fixtures/mock/`. A codegen tool bakes every `*.json` into a committed `Map<String,String>` Dart file (`mock_fixtures.g.dart`), and the server reads the **map**, not the disk — removing filesystem timing and asset-bundling from the hot path.

- Both the source JSON **and** the generated `.g.dart` are **committed**.
- Nothing is declared as a pubspec asset — the fixtures never ship in the release binary.
- Regeneration is a **manual, committed step** (`dart run tool/gen_mock_fixtures.dart`), re-run whenever a fixture is added/edited/removed.

---

## 5. Fixture taxonomy → mechanism table (the classification key) <!-- 21 -->

This is the worker's classification key at **Gate M**. For each endpoint/case the scenario needs, pick the row, then use the pipeline stage + facade call in its columns. Most cases need **no new fixture or route** — they are arranged per-scenario through the higher pipeline layers.

| # | Case class | Mechanism | Stage | Facade call |
|---|---|---|---|---|
| 1 | **Happy-path success** | Static fixture + manifest entry (status 200), normal envelope | ⑥ | — (base route) |
| 2 | **Empty / zero-state** | Fixture with an empty collection — base route, or swapped per-scenario | ⑥ / ③ | `stubFixture` |
| 3 | **Alternate success variant** | Separate fixture via a synthetic `/__mock__/` route, or an edited body | ⑥ / ③ | `stubFixture` / `stubSuccessBody` |
| 4 | **Error (4xx / 5xx)** | Per-scenario error-body override with a status; or a manifest entry with an error status | ③ / ⑥ | `stubErrorBody` |
| 5 | **State-dependent status** | Stateful branch returns a fixture at a computed status | ④ | — (branch) |
| 6 | **Sequenced / fail-once** | Override with use-count N fires N times then auto-evicts; next request falls through | ③ | `stubOnce` |
| 7 | **Latency / loading state** | Delay entry sleeps before any source serves | ② | `delay` |
| 8 | **Stateful mutation** (toggle, ledger, queue) | Module-level state + stateful branch; a write flips/accumulates, a later read reflects it | ④ | — (branch) |
| 9 | **Dynamic write echo** | Response synthesized from the request body (generated id, echoed fields) | ⑤ | — (branch) |
| 10 | **Growing collection** | Read overlay keyed on fixture identity mutates the served body from state | ⑥ + overlay | — (branch) |
| 11 | **Alternate context** (2nd tenant, conflict) | Synthetic `/__mock__/` route fetched on demand for a different fixture | ⑥ | `stubFixture` |
| 12 | **Outgoing-payload assertion** | Not a response — assert on the capture log | ① | `requests` |

---

## 6. The arrange facade contract <!-- 20 -->

Scenarios never touch server internals. They arrange through a thin facade whose **every method no-ops unless the mock env is active** — so the SAME scenario file is inert against a real backend and stays portable (dual-mode-safe). This is the ONE place the mock/real guard lives.

| Method | Use |
|---|---|
| `stubFixture(method, pathRegex, file, {status})` | Serve a validated fixture (**prefer this** — keeps bodies honest). |
| `stubSuccessBody(method, pathRegex, {status, body})` | An edited success-shaped variant when no fixture fits. |
| `stubErrorBody(method, pathRegex, {status, body})` | Inline body — **error envelopes only**, never a success payload. |
| `stubOnce(method, pathRegex, {status, body, times})` | Sequenced (use-count) — fires N times then falls through (fail-then-succeed). |
| `delay(pathRegex, ms, {method})` | Inject latency for a loading-state assertion. |
| `requests({method, pathRegex})` | Read the capture log — assert on the outgoing payload/headers. |
| `clear()` | Drop all overrides/delays; revert to route-table + stateful rules. |

**Two timing paths** decide *where* you arrange:
- **POST-BOOT** — endpoint fetched on a navigated-to screen or a tap → arrange **inline in the scenario body, before** the interaction that triggers the call.
- **BOOT-TIME** — endpoint fetched during app start (permissions, session, initial snapshot) → arrange in a hook (`arrangeMockOnNextLaunch`) that runs **after** the state reset and **before** the app starts (the only window in which a boot-time endpoint can be overridden).

---

## 7. Boot ordering (the happens-before chain) <!-- 17 -->

The boot is strictly sequential — **there is no race window**. The bootstrap `await`s server-listening and session-seeded **before** it starts the app, and the server's start Future resolves **only once the socket is bound and accepting**. The mandatory chain:

> await server listening → seed session → app.main() → session restored + boot-time fetches issued

So the app can never issue an HTTP call before the server is ready. `launchApp($)` is the contract:

```
launchApp($):  startMockServer()  →  resetMockServerState()  →  run pending arrange hook
             →  seedSession()  →  app.main()  →  pump until the boot landmark is in the tree
```

All of the mock steps are gated on `<DISCOVERED: isMock check>` — a non-mock run starts no server and touches no storage.

---

## 8. Lifecycle & teardown <!-- 12 -->

| Hook | Call | Why |
|---|---|---|
| `setUpAll` | `clearAppData()` | Force a fresh-install state once per suite (`<DISCOVERED: clear-data cmd>`). Must fully **await** the clear subprocess (a fire-and-forget clear races app.main() and SIGKILLs the fresh process mid-scenario). |
| `setUp` | `resetMockServerState()` | Clear overrides, delays, capture log, and all in-memory stateful stores — per-scenario isolation. |
| `tearDown` | `stopMockServer()` | **Load-bearing, not hygiene.** Close the socket forcefully (`close(force: true)`). |

**Teardown is load-bearing.** A live listening socket keeps the isolate alive; skip the stop-server step and the process cannot exit between the runner's per-scenario launches — the run stalls or the native coordinator fails the whole suite. Prefer **process-per-scenario** isolation (fresh globals, cleared app data); the bootstrap re-binds the port for the next scenario. Idempotency guards ("already started, return") scope to a single process only — they are not cross-scenario reuse.

---

## 9. The cache-fallback trap <!-- 8 -->

In offline-first apps, a repository that falls back to a local cache on remote failure will **mask an injected error** — the error UI never renders because the cache answers. Error injection (case 4/6) only works against endpoints whose repository **surfaces the failure directly** — writes, or online-only reads.

**Rule:** before selecting an error-injection target, verify the repository's failure branch actually surfaces to the UI (read the repo/data-source and confirm it does not swallow the error into a cached value). Tag any error-injection or synthetic scenario **`mockonly`** (§13) so it runs only in mock mode.

---

## 10. Capture-first / synthesize-fallback fixture procedure <!-- 11 -->

Fixture bodies are produced by a strict precedence — **capture beats synthesis:**

1. **Freeze a real captured response verbatim.** If the user supplies a real captured response (from a proxy log, a dev-tools dump, a saved Postman example), freeze it exactly. Redact secrets/PII but preserve representative shape and values.
2. **Only when none exists, synthesize** from the app's Dart response models (the `fromJson` the endpoint parses through) or the OpenAPI schema — and **FLAG FOR REVIEW**: emit a visible marker in the worker's output/report (e.g. `⚠ SYNTHESIZED — needs review: orders.json`), **never inside the JSON** (a marker key would break the semantic gate).

**Never repopulate fixtures from a live API call** as a routine step — capture a real response **once**, freeze it, keep representative static values. Any contract-impacting change (a response-model edit, a new endpoint, a fixture edit) re-validates fixtures **in the same change** (§11).

---

## 11. Honesty gates (three automated checks) <!-- 14 -->

Static fixtures rot silently — compiler, linter, and unit suite all stay green against a fixture that no longer matches the contract. Three automated gates defend it. These are **automated**, not human gates (the human gate is Gate M, §qa-gates).

| Gate | Kind | Catches |
|---|---|---|
| **Structural** | Mechanical (plain Dart, no device) | Manifest not a well-typed array; a non-compiling regex; duplicate `(method,path)`; a referenced-but-missing fixture; an orphan fixture; invalid fixture JSON |
| **Semantic parse** | Mechanical (plain `dart test`) | A fixture whose shape no longer parses through the app's **real response model** (`fromJson`) / the shared envelope |
| **Contract diff** | Contract (when an OpenAPI/spec exists) | Fixture *shape* drift vs. the API's published schema, on a severity ladder |

Structural and semantic gates are **mandatory** and always generated. Contract-diff is generated **only when the app has a spec** to diff against.

---

## 12. Naming & paths (canonical layout) <!-- 28 -->

```
integration_test/
├── fixtures/
│   ├── mock/
│   │   ├── manifest.json            # ordered route table (§4a)
│   │   └── <resource>.json          # one fixture per response shape
│   └── mock_fixtures.g.dart         # GENERATED, committed — do not edit (§4b)
├── helpers/
│   ├── mock_server.dart             # shelf server: the 7-stage pipeline (§3)
│   ├── mock_control.dart            # the arrange facade (§6)
│   ├── mock_session.dart            # programmatic-auth seeding (§2b)
│   ├── mock_seed_helpers.dart       # alternate seed shapes (no-outlet, unauthenticated, …)
│   └── app_helper.dart              # launchApp($) boot ordering (§7)
└── ...
tool/
└── gen_mock_fixtures.dart           # fixtures codegen (§4b)
scripts/harness/checks/
└── check_mock_fixtures.dart         # structural gate (§11)
test/.../mock/
└── fixture_contract_test.dart       # semantic parse gate (§11)
```

**Fixture file naming:** `<resource>[_<qualifier>].json`, lowercase snake_case, describing the response it holds — `orders.json`, `orders_empty.json`, `orders_error.json`, `order_detail.json`. The filename is the manifest `file` key AND the overlay coupling key, so **keep overlay-backed fixture names stable** — renaming one silently disables its overlay.

---

## 13. Mock-aware Patrol authoring <!-- 35 -->

`patrol-standard.md` is the authority for general Patrol authoring (folder structure, selectors, copy verification, `launchApp($)` as the mandatory first line); **this document is the authority for the mock internals** every Patrol test relies on — UI automation always runs in mock mode; the hermetic mock backend is a hard prerequisite, not an option.

- **Arrange via the facade, per taxonomy case (§5).** POST-BOOT: arrange inline before the triggering interaction. BOOT-TIME: arrange in the `arrangeMockOnNextLaunch` hook. Always route through the facade (`MockControl`), never the server directly — so the same file stays real-backend-portable.
- **Run command shape** (mock env):

  ```shell
  patrol test --target integration_test/<path>/<file>.dart \
    --dart-define=<DISCOVERED: env flag>=MOCK \
    -d <device>
  ```

- **`mockonly` tag.** Error-injection (§9), sequenced, latency, and synthetic-route scenarios assert states only reproducible in mock mode — tag them `mockonly` so they are **excluded from real-backend runs**. Happy-path scenarios stay untagged and run in both modes.

**Error-then-recover shape:**

```dart
// arrange BEFORE navigating into the screen
MockControl.stubErrorBody('GET', r'^<DISCOVERED: api prefix>/reports/summary',
    status: 500, body: errorEnvelope);
//  ... open screen -> assert error banner + Retry ...
MockControl.clear();   // Retry re-issues the GET and now succeeds
```

**Sequenced (fail-once) shape:**

```dart
// first call 401 -> client refreshes token & retries -> second falls through to 200
MockControl.stubOnce('GET', r'^<DISCOVERED: api prefix>/session/current',
    status: 401, body: unauthorizedEnvelope);
```

---

## Code skeletons (generalized — substitute discovered values) <!-- 245 -->

These are structure + signatures with obvious bodies elided. They are derived from a working reference implementation; adapt them by substituting `<DISCOVERED: …>` facts. Do not invent a different structure.

### shelf server handler pipeline (`mock_server.dart`)

```dart
import 'dart:convert';
import 'dart:io';
import 'package:shelf/shelf.dart' as shelf;
import 'package:shelf/shelf_io.dart' as shelf_io;
import '../fixtures/mock_fixtures.g.dart';

const mockServerPort = <DISCOVERED: port>;
HttpServer? _server;

// ── per-scenario mutable state (all reset in resetMockServerState) ──
final List<_Override> _overrides = [];   // ③
final List<_Delay> _delays = [];         // ②
final List<CapturedRequest> _requestLog = []; // ① bounded FIFO
// ④/⑤ declare one module-level store per stateful domain you model here.

void resetMockServerState() {
  _overrides.clear();
  _delays.clear();
  _requestLog.clear();
  // ...clear every stateful store declared above...
}

Future<shelf.Response> _handler(shelf.Request request) async {
  final method = request.method.toUpperCase();
  final path = request.requestedUri.path; // query stripped, per §3

  // ① capture — read body ONCE (a shelf stream is single-listen), record first
  final decodedBody = _tryDecodeJson(await request.readAsString());
  _recordRequest(request, decodedBody); // redacts Authorization

  // ② delay
  for (final d in _delays) {
    if (d.method == method && d.pattern.hasMatch(path)) {
      await Future<void>.delayed(Duration(milliseconds: d.milliseconds));
      break;
    }
  }

  // ③ overrides (first-match-wins; decrement + auto-evict maxUses)
  for (final o in _overrides) {
    if (o.method == method && o.pattern.hasMatch(path)) {
      final body = o.body ?? mockFixtures[o.file]!; // ! = loud fail on bad key
      if (o.maxUses != null && --o.maxUses! <= 0) _overrides.remove(o);
      _log('OVERRIDE', method, path, o.status);
      return _json(o.status, body);
    }
  }

  // ④ stateful branches — one `if` per modeled domain, e.g.:
  //   if (method == 'GET' && !_flagOpen && _re(path, r'^.../resource/current')) return _json(404, ...);
  // ⑤ dynamic echo — write endpoints synthesize from decodedBody, splice into a later read.

  // ⑥ route table + overlays + synthetic /__mock__/ routes
  final matched = _loadManifest().firstWhereOrNull(
      (e) => e.method == method && e.pattern.hasMatch(path));
  if (matched == null) {
    _log('NOT-FOUND', method, path, 501);           // ⑦ hard, never proxied
    return _json(501, _notFoundEnvelope(method, path));
  }
  var body = mockFixtures[matched.file]!;
  // GET overlays: mutate `body` from accumulated state, keyed on matched.file.
  _log('ROUTE', method, path, matched.status);
  return _json(matched.status, body);
}

Future<void> startMockServer() async {
  if (_server != null) return;                       // idempotent per process
  _server = await shelf_io.serve(
      _handler, InternetAddress.loopbackIPv4, mockServerPort);
}

Future<void> stopMockServer() async {
  await _server?.close(force: true);                 // §8 load-bearing
  _server = null;
}
```

### arrange facade (`mock_control.dart`)

```dart
import 'package:<DISCOVERED: package name>/<DISCOVERED: base-url config>.dart';
import 'mock_server.dart' as srv;
export 'mock_server.dart' show CapturedRequest;

/// Every method no-ops unless the mock env is active — the ONE mock/real guard.
abstract final class MockControl {
  static void stubFixture(String method, String pathRegex, String file,
      {int status = 200}) {
    if (!<DISCOVERED: isMock check>) return;
    srv.addMockOverride(method: method, path: pathRegex, file: file, status: status);
  }

  static void stubErrorBody(String method, String pathRegex,
      {required int status, required String body}) {
    if (!<DISCOVERED: isMock check>) return;         // error envelopes ONLY
    srv.addMockOverride(method: method, path: pathRegex, body: body, status: status);
  }

  static void stubSuccessBody(String method, String pathRegex,
      {int status = 200, required String body}) { /* like above; edited success shape */ }

  static void stubOnce(String method, String pathRegex,
      {required int status, required String body, int times = 1}) {
    if (!<DISCOVERED: isMock check>) return;
    srv.addMockOverride(method: method, path: pathRegex, body: body,
        status: status, maxUses: times);
  }

  static void delay(String pathRegex, int ms, {String method = 'GET'}) { /* guard + addMockDelay */ }

  static List<srv.CapturedRequest> requests({String? method, String? pathRegex}) {
    if (!<DISCOVERED: isMock check>) return const [];
    return srv.getCapturedRequests(method: method, pathRegex: pathRegex);
  }

  static void clear() { /* guard + clearMockOverrides + clearMockDelays */ }
}
```

### launchApp boot ordering (`app_helper.dart`)

```dart
import 'package:<DISCOVERED: package name>/<DISCOVERED: app entrypoint>' as app;
import 'mock_server.dart';
import 'mock_session.dart';

bool _appStarted = false;
void Function()? _pendingArrange;

/// BOOT-TIME arrange hook: runs after reset, before app.main(). No-op off mock.
void arrangeMockOnNextLaunch(void Function() fn) {
  if (!<DISCOVERED: isMock check>) return;
  _pendingArrange = fn;
}

Future<void> launchApp(PatrolIntegrationTester $) async {
  if (_appStarted) return;
  if (<DISCOVERED: isMock check>) {
    await startMockServer();        // resolves only once socket is bound (§7)
    resetMockServerState();
    _pendingArrange?.call();        // register boot-time overrides
    _pendingArrange = null;
    await seedMockSession();        // §2b programmatic auth
  }
  app.main();                       // §7: server + session ready BEFORE this
  for (var i = 0; i < 60; i++) {    // pump until the boot landmark appears
    await $.pump(const Duration(milliseconds: 500));
    if (_bootLandmarkVisible()) break;
  }
  _appStarted = true;
}
```

### fixtures codegen (`tool/gen_mock_fixtures.dart`)

```dart
import 'dart:io';

void main() {
  const srcDir = 'integration_test/fixtures/mock';
  const out = 'integration_test/fixtures/mock_fixtures.g.dart';
  final files = Directory(srcDir).listSync().whereType<File>()
      .where((f) => f.path.endsWith('.json')).toList()
    ..sort((a, b) => a.path.compareTo(b.path));

  final b = StringBuffer()
    ..writeln('// GENERATED — do not edit. Run: dart run tool/gen_mock_fixtures.dart')
    ..writeln('const Map<String, String> mockFixtures = {');
  for (final f in files) {
    final name = f.uri.pathSegments.last;
    final raw = f.readAsStringSync();
    b.writeln("  '$name': r'''\n$raw''',");   // raw string; JSON-safe delimiter
  }
  b.writeln('};');
  File(out).writeAsStringSync(b.toString());
  stdout.writeln('Wrote $out (${files.length} fixtures).');
}
```

### structural gate (`scripts/harness/checks/check_mock_fixtures.dart`)

```dart
// Exit 0 = clean, 1 = violation(s). No package deps, device-free.
// Fails if: manifest.json missing-array-or-bad-type; any entry lacks string
// method/path/file (+ optional int status 100..599); any path is not a valid
// RegExp; any (method,path) declared twice; any referenced file missing or
// invalid JSON; any *.json under fixtures/mock (except manifest) is an orphan.
import 'dart:convert';
import 'dart:io';

void main() {
  const dir = 'integration_test/fixtures/mock';
  final manifestFile = File('$dir/manifest.json');
  if (!manifestFile.existsSync()) { exit(0); }      // no mock backend yet → pass
  final manifest = jsonDecode(manifestFile.readAsStringSync());
  final errors = <String>[];
  final referenced = <String>{}, seenRoutes = <String>{};
  // ...iterate entries: type-check fields, compile RegExp(path), dedupe
  //    "METHOD path", confirm each file exists + parses, collect referenced...
  // ...then scan dir for *.json not in `referenced` → orphan errors...
  if (errors.isEmpty) exit(0);
  errors.forEach(stderr.writeln);
  exit(1);
}
```

### semantic parse gate (`test/.../mock/fixture_contract_test.dart`)

```dart
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
// import the app's REAL response models to parse through.

void main() {
  // fixture filename → validator that THROWS on drift. Prefer the endpoint's
  // real fromJson; fall back to the shared envelope shape.
  final contracts = <String, void Function(dynamic)>{
    'orders.json': _envelope,
    // ...one entry per manifest fixture...
  };
  for (final e in contracts.entries) {
    test('${e.key} still fits the contract', () {
      final body = jsonDecode(
          File('integration_test/fixtures/mock/${e.key}').readAsStringSync());
      expect(() => e.value(body), returnsNormally,
          reason: '${e.key} drifted from contract.');
    });
  }
  test('every manifest fixture has a contract entry', () {
    final files = (jsonDecode(File(
            'integration_test/fixtures/mock/manifest.json').readAsStringSync())
        as List).map((e) => e['file'] as String).toSet();
    expect(files.difference(contracts.keys.toSet()), isEmpty,
        reason: 'unguarded fixtures — add them to `contracts`.');
  });
}
```
