---
name: developer-test-procedure
description: Four-step unit test creation procedure — create or extend a test file, determine if mocks are needed, generate missing mocks using the platform-specific procedure, then verify correctness of all test cases.
user-invocable: false
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, mcp__plugin_cipherpol-1_cp1__search_docs, mcp__cp1-dev__search_docs
---

## Inputs

Required — caller must supply all three:

| Parameter | Description |
|---|---|
| `target` | Absolute path to the source artifact under test |
| `platform` | `ios-swift` / `android-kotlin` / `flutter` / `web-nextjs` |
| `layer` | `domain` / `data` / `presentation` |

Return `MISSING INPUT: <param>` immediately if any are absent.

## Scope Boundary

Unit tests only. No UI/integration tests. No modifications to production source files.

## Platform Reference

Before executing any step, load the platform testing patterns from the cp-1 doc store (see `$CLAUDE_PLUGIN_ROOT/reference/aegis/cp1-retrieval.md` for server selection + fallback):

- `search_docs(slug="_global", query="testing <the specific pattern this step needs — e.g. naming convention, mock generation, repository test, presenter test>", platform=["{platform}"], doc_type=["standard"])` — search per-step for the specific testing node you need (breadcrumb `Standard Architecture > Testing > …`); do not pull everything upfront.

If nothing relevant returns for testing, STOP and report a knowledge gap for `{platform} standard-architecture / testing`.

All variable details (file naming, mock location, mock generation command, test runner) come from these fetched patterns. The steps below are the fixed procedure; the fetched patterns fill in the variables.

---

## Step 1 — Resolve Test File

1. Derive the test file path from `target` using the naming convention from the fetched testing patterns (the naming-convention pattern).
2. `Glob` for the test file path.
   - **Not found** → create the test file with the correct scaffold (class declaration, imports, `setUp`/`tearDown` or equivalent).
   - **Found** → open and read the existing test file — add the new test cases without removing existing ones.

## Step 2 — Determine Mock Need

Inspect `target` via `Grep` for its direct dependencies (constructor params, injected interfaces).

Consult the layer-to-mock table from `developer-test-worker`:

| Layer | Mock needed |
|---|---|
| Domain entity / service | None — pure data or pure functions |
| Use case | Repository interface |
| Mapper | None — pure transformation |
| DataSource impl | Network/DB client |
| Repository impl | DataSource + Mapper |
| StateHolder / BLoC / ViewModel | Use case interfaces |

If no mocks are needed, skip to Step 4.

## Step 3 — Resolve Mocks

For each required mock:

1. Derive the expected mock path using the mock-location details from the fetched testing patterns.
2. `Glob` for the mock file.
   - **Found** → reuse. Note the path for Step 4.
   - **Not found** → create or generate the mock:
     - Fetch the mock-generation pattern from the testing topic for the strategy and generation command.
     - If the platform uses code generation (e.g., `build_runner`, `MockGen.sh`): add the mock spec annotation to the appropriate helper file, then run the generation command via `Bash`.
     - If the platform uses manual mocks: write the mock class file following the platform's mock pattern.

## Step 4 — Verify Test Cases

1. Re-read the test file (or read it for the first time if just created).
2. For each test case, verify:
   - Follows Arrange-Act-Assert structure.
   - Covers the happy path.
   - Covers all error paths and relevant edge cases (one branch = one test).
   - Mock setup matches the expected call count for the execution path.
   - Assertions target the correct output field or state.
3. Fix any incorrect test cases inline via `Edit`.
4. Run the test suite using the test-runner command from the fetched testing patterns.
5. If tests fail, diagnose using the platform reference's failure patterns and fix — repeat until green.

## Output

```
## Output
- <path/to/test/file>
- <path/to/mock/file-if-created>
```
