# Cipherpol Stage 2 Real-Corpus Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking. Workers must not run project-wide validation; the orchestrator runs focused checks after each dependency wave and the complete suite once at the end.

**Goal:** Deterministically materialize, admit, sign, map, aggregate, verify, and commit the complete shipping `software-dev-agentic` corpus as a reproducible Cipherpol registry fixture.

**Architecture:** Extend the existing importer with explicit materialization descriptors, build 152 immutable physical packages from the pinned authored source revision, admit them through one batch gate snapshot, persist one signed package envelope per package, and compose a separately signed registry envelope containing a complete 168-entry closure manifest. Add an additive signed-registry loader while leaving Stage 1 `loadRegistry` unchanged.

**Tech Stack:** Node.js 20+, TypeScript 5, pnpm 10, Zod 3, YAML 2, semver 7, Node crypto Ed25519, Node test runner via `tsx --test`.

**Approved design:** `docs/superpowers/specs/2026-08-14-cipherpol-stage2-closure-design.md`

---

## Stage boundary and invariants

The implementation must preserve these invariants:

```text
source revision: a8afa8dd0848833b72ef536e1258d5c27bb8e3fc
physical packages: 152
parity mappings: 168
classified parity entries: 167
taxonomy mappings: 1
cp1 MCP mappings: 17 -> one shared adapter package
```

No generated `software-dev-agentic/dist/**` path is an authored input. No timestamp, absolute source path, locale-dependent ordering, random ID, process ID, or temporary path may enter signed output.

The final commit is intentionally atomic. Do not create intermediate implementation commits; the design commit `58a9c13` is already separate and approved.

## File map

```text
packages/contracts/src/artifact.ts                 canonical path/byte digest
packages/contracts/src/schemas.ts                  file mode, closure, registry-envelope schemas
packages/contracts/src/models.ts                   inferred closure/envelope types
packages/contracts/src/index.ts                    artifact and closure exports
packages/contracts/test/artifact.test.ts           digest determinism tests
packages/contracts/test/schemas.test.ts            closure/envelope schema tests

packages/admission/src/import-policy.ts             checked-in policy loader
packages/admission/src/importer.ts                  materialization descriptors
packages/admission/src/materialize.ts               secure deterministic package copier
packages/admission/src/admission.ts                 batch admission API and mode checks
packages/admission/src/closure.ts                   closure manifest and registry composer
packages/admission/src/registry-signing.ts           aggregate signing/verification
packages/admission/src/reproducibility.ts            clean-room tree comparison
packages/admission/src/cli.ts                       close and verify-closure commands
packages/admission/src/index.ts                     new exports
packages/admission/test/import-policy.test.ts        policy failures
packages/admission/test/materialize.test.ts          complete copy and package mapping
packages/admission/test/closure.test.ts              152/168 mapping and signing
packages/admission/test/reproducibility.test.ts      byte/mode equality
packages/admission/test/cli.e2e.test.ts              closure CLI behavior
packages/admission/test/fixtures/closure-source/     portable miniature corpus

packages/resolver/src/digest.ts                     safe shared canonical digest use
packages/resolver/src/load.ts                       additive loadSignedRegistry
packages/resolver/src/assemble.ts                   declared mode application
packages/resolver/src/index.ts                      signed loader export
packages/resolver/test/digest.test.ts                safe digest behavior
packages/resolver/test/signed-registry.test.ts       aggregate/package trust boundary
packages/resolver/test/assemble.test.ts              runtime mode application

fixtures/software-dev-agentic/import-policy.yaml
fixtures/software-dev-agentic/stage2-fixture-private.pem
fixtures/software-dev-agentic/stage2-fixture-public.pem
fixtures/software-dev-agentic/FIXTURE-KEY-NOTICE.txt
fixtures/software-dev-agentic-registry/artifacts/**
fixtures/software-dev-agentic-registry/admissions/**
fixtures/software-dev-agentic-registry/registry-envelope.json
fixtures/software-dev-agentic-registry/fixture-public-key.pem

package.json                                        closure scripts
.gitignore                                          staging/private runtime ignores only
```

---

### Task 1: Unify canonical artifact and closure contracts

**Files:**
- Create: `packages/contracts/src/artifact.ts`
- Modify: `packages/contracts/src/schemas.ts`
- Modify: `packages/contracts/src/models.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/artifact.test.ts`
- Modify: `packages/contracts/test/schemas.test.ts`

- [ ] **Step 1: Write canonical digest tests**

Create tests covering registry-order independence, Unicode code-point path order, duplicate-path rejection, and byte sensitivity:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalArtifactDigest } from "../src/index.js";

const a = { path: "z/file.md", bytes: Buffer.from("z") };
const b = { path: "A/file.md", bytes: Buffer.from("a") };

test("canonical artifact digest is independent of input order", () => {
  assert.equal(canonicalArtifactDigest([a, b]), canonicalArtifactDigest([b, a]));
});

test("canonical artifact digest rejects duplicate paths", () => {
  assert.throws(() => canonicalArtifactDigest([a, a]), /duplicate artifact path/);
});

test("canonical artifact digest changes with bytes", () => {
  assert.notEqual(
    canonicalArtifactDigest([a]),
    canonicalArtifactDigest([{ ...a, bytes: Buffer.from("changed") }]),
  );
});
```

- [ ] **Step 2: Verify focused failure**

Run:

```bash
pnpm --filter @cipherpol/contracts test
```

Expected: FAIL because `canonicalArtifactDigest` is absent.

- [ ] **Step 3: Implement the shared digest primitive**

Create `packages/contracts/src/artifact.ts` with this public contract:

```ts
import { createHash } from "node:crypto";

export interface CanonicalArtifactFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export function canonicalArtifactDigest(files: readonly CanonicalArtifactFile[]): string {
  const ordered = [...files].sort((left, right) => compareCodePoints(left.path, right.path));
  const seen = new Set<string>();
  const hash = createHash("sha256");
  for (const file of ordered) {
    if (seen.has(file.path)) throw new Error(`duplicate artifact path: ${file.path}`);
    seen.add(file.path);
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
```

The implementation must validate normalized traversal-free POSIX paths before hashing; do not accept empty, absolute, backslash, dot, or parent segments.

- [ ] **Step 4: Add additive file-mode and closure schemas**

Extend package file mappings additively:

```ts
const artifactModeSchema = z.union([z.literal(0o644), z.literal(0o755)]);

files: z.array(z.object({
  source: relativePath,
  target: relativePath,
  mode: artifactModeSchema.optional(),
})).min(1),
```

Add:

```ts
export const closurePackageMappingSchema = z.object({
  parityId: stableId,
  mappingType: z.literal("package"),
  packageId: stableId,
  packageVersion: version,
  packageDigest: digest,
  admissionPath: relativePath,
}).strict();

export const closureMcpMappingSchema = z.object({
  parityId: stableId,
  mappingType: z.literal("mcp-tool"),
  packageId: stableId,
  packageVersion: version,
  packageDigest: digest,
  admissionPath: relativePath,
  capability: z.string().regex(/^[a-z][a-z0-9_]*$/),
}).strict();

export const closureManifestSchema = z.object({
  schemaVersion: z.literal("cipherpol.closure/v1"),
  sourceRevision: z.string().min(7),
  paritySchemaVersion: z.literal("cipherpol.parity/v2"),
  parityManifestDigest: digest,
  mappings: z.array(z.discriminatedUnion("mappingType", [
    closurePackageMappingSchema,
    closureMcpMappingSchema,
  ])).min(1),
}).strict();

export const registryEnvelopeSchema = z.object({
  schemaVersion: z.literal("cipherpol.registry-envelope/v1"),
  registryIndex: registryIndexSchema,
  closureManifest: closureManifestSchema,
  keyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  algorithm: z.literal("Ed25519"),
  keyPurpose: z.enum(["fixture", "production"]),
  signature: z.string().min(1),
}).strict();
```

Add `superRefine` rules for unique parity IDs, exact 17 MCP mappings with distinct capabilities, registry package references, matching versions/digests, and at least one closure mapping per registry package. The generic schema does not hardcode 168 entries; `composeClosureManifest` receives the authoritative parity manifest, verifies its canonical digest, and requires exact set equality. The real closure tests assert the source-specific count of 168.

- [ ] **Step 5: Export inferred types and APIs**

Export `CanonicalArtifactFile`, `canonicalArtifactDigest`, `ArtifactMode`, `ClosureManifest`, mapping types, and `RegistryEnvelope` through `models.ts` and `index.ts`.

- [ ] **Step 6: Add schema compatibility tests**

Tests must prove:

- Stage 1 package records without mode still parse;
- modes other than 0644/0755 fail;
- duplicate parity mappings fail;
- unknown packages or mismatched digests fail;
- non-distinct MCP capabilities fail;
- valid 168-entry closure fixture shape parses.

- [ ] **Step 7: Run focused verification**

```bash
pnpm --filter @cipherpol/contracts test
pnpm --filter @cipherpol/contracts typecheck
```

Expected: all contract tests PASS and strict typecheck exits zero.

---

### Task 2: Define import policy and materialization descriptors

**Files:**
- Create: `packages/admission/src/import-policy.ts`
- Modify: `packages/admission/src/importer.ts`
- Modify: `packages/admission/src/index.ts`
- Create: `packages/admission/test/import-policy.test.ts`
- Modify: `packages/admission/test/importer.test.ts`
- Create: `fixtures/software-dev-agentic/import-policy.yaml`

- [ ] **Step 1: Write failing policy tests**

Use a portable fixture policy and assert valid parsing, missing module rejection, invalid semver rejection, unknown dependency IDs, and cyclic policy dependencies.

```ts
test("loads explicit module metadata and exact package dependencies", async () => {
  const policy = await loadImportPolicy(policyPath);
  assert.equal(policy.modules["cipherpol-aegis"].packageVersion, "module-version");
  assert.equal(policy.modules["cipherpol-aegis"].owner, "mobile-platform");
});
```

- [ ] **Step 2: Implement runtime-validated import policy**

Public API:

```ts
export interface ModuleImportPolicy {
  readonly owner: string;
  readonly packageVersion: "module-version";
  readonly claudeCode: string;
  readonly capabilities: readonly string[];
}

export interface SoftwareDevAgenticImportPolicy {
  readonly schemaVersion: "cipherpol.import-policy/v1";
  readonly modules: Readonly<Record<SoftwareDevAgenticModule, ModuleImportPolicy>>;
  readonly packageDependencies: Readonly<Record<string, readonly string[]>>;
}

export async function loadImportPolicy(path: string): Promise<SoftwareDevAgenticImportPolicy>;
```

Validate semver ranges with `validRange`. Dependencies use `stable-id@range`; all referenced IDs must be among imported package IDs before materialization begins.

- [ ] **Step 3: Add explicit materialization descriptors to importer output**

Extend `SoftwareDevAgenticImportResult`:

```ts
export interface ImportedArtifactDescriptor {
  readonly packageId: string;
  readonly parityIds: readonly string[];
  readonly module: SoftwareDevAgenticModule;
  readonly moduleVersion: string;
  readonly packageKind: PackageRecord["kind"];
  readonly sourceKind: "directory" | "file" | "cp1-adapter";
  readonly sourcePaths: readonly string[];
  readonly targetRoot: string;
}

export interface SoftwareDevAgenticImportResult {
  // existing fields remain
  readonly artifacts: readonly ImportedArtifactDescriptor[];
}
```

Mappings:

```text
orchestrator, contract -> skill directory
internal-procedure     -> procedure directory
agent                  -> one Markdown file
reference              -> one Markdown file
taxonomy               -> root cipherpol.json
17 mcp-tool entries     -> one cp1 adapter descriptor
```

The adapter descriptor must derive source selection from the authored `cipherpol-1/plugin/build.sh` deploy contract, not generated `dist/`.

- [ ] **Step 4: Assert exact descriptor counts**

Portable and real-source tests assert:

```text
artifacts.length = 152
skill/procedure = 67
agents = 47
references = 36
taxonomy = 1
adapter = 1
adapter.parityIds.length = 17
```

Every one of the 168 parity IDs must occur in exactly one descriptor’s `parityIds`.

- [ ] **Step 5: Add checked-in policy**

Create the exact approved policy from the design, with all three module entries and an initially empty explicit dependency map. Add a comment explaining that parity composition is not an install dependency.

- [ ] **Step 6: Run focused verification**

```bash
SOFTWARE_DEV_AGENTIC_ROOT=/Users/iqbal/projects/software-dev-agentic \
  pnpm --filter @cipherpol/admission test -- test/import-policy.test.ts test/importer.test.ts
pnpm --filter @cipherpol/admission typecheck
```

Expected: policy and real descriptor count tests PASS.

---

### Task 3: Materialize all packages and gate views

**Files:**
- Create: `packages/admission/src/materialize.ts`
- Modify: `packages/admission/src/index.ts`
- Create: `packages/admission/test/materialize.test.ts`
- Create: `packages/admission/test/fixtures/closure-source/**`

- [ ] **Step 1: Write failing materializer tests**

Tests cover:

- complete skill directory copy, including `procedure.md`, executable scripts, and auxiliary prompts;
- agent/reference/taxonomy file layout;
- shared adapter layout;
- 0644/0755 normalization;
- symlink and special-file rejection;
- source replacement detection;
- stable ID path encoding and collision rejection;
- no absolute source paths in result metadata.

- [ ] **Step 2: Define materializer result types**

```ts
export interface MaterializedFile {
  readonly source: string;
  readonly target: string;
  readonly mode: 0o644 | 0o755;
}

export interface MaterializedPackage {
  readonly descriptor: ImportedArtifactDescriptor;
  readonly artifactRoot: string;
  readonly artifactPath: string;
  readonly files: readonly MaterializedFile[];
}

export interface MaterializedClosure {
  readonly root: string;
  readonly packages: readonly MaterializedPackage[];
  readonly skillsDirectory: string;
  readonly agentsDirectory: string;
}

export async function materializeClosure(input: {
  sourceRoot: string;
  outputRoot: string;
  imported: SoftwareDevAgenticImportResult;
}): Promise<MaterializedClosure>;
```

- [ ] **Step 3: Implement secure source collection**

Use no-follow opens, realpath containment, pre/post stable metadata checks, and code-point ordering. Copy each file once from collected bytes to the stage. Set normalized modes explicitly after write.

Do not call shell `cp`, preserve mtimes, or copy directory metadata.

- [ ] **Step 4: Build complete flat views**

For each materialized mapping, copy/hard-link the exact collected bytes into closure-local:

```text
.gates/skills/<name>/**
.gates/agents/<name>.md
```

Reject any target collision. These views are staging-only and are not part of the persisted registry fixture.

- [ ] **Step 5: Assert the real package count**

Real-source smoke in the test process must assert `packages.length === 152` and verify no source path contains `/dist/`.

- [ ] **Step 6: Run focused verification**

```bash
SOFTWARE_DEV_AGENTIC_ROOT=/Users/iqbal/projects/software-dev-agentic \
  pnpm --filter @cipherpol/admission test -- test/materialize.test.ts
pnpm --filter @cipherpol/admission typecheck
```

Expected: portable and real materialization checks PASS.

---

### Task 4: Generate package records and batch-admit the complete set

**Files:**
- Modify: `packages/admission/src/admission.ts`
- Create: `packages/admission/src/package-records.ts`
- Modify: `packages/admission/src/index.ts`
- Modify: `packages/admission/test/admission.test.ts`
- Create: `packages/admission/test/package-records.test.ts`

- [ ] **Step 1: Write failing package-record tests**

Assert that package metadata derives only from descriptor + policy + measured files:

```ts
assert.equal(records.length, 152);
assert.equal(records[0]?.sourceRevision, sourceRevision);
assert.deepEqual(records[0]?.compatibility, {
  claudeCode: ">=2.1.0 <3.0.0",
  capabilities: ["plugins"],
});
```

Tests reject missing policy, undeclared dependencies, target/kind mismatch, invalid modes, and module-version mismatch.

- [ ] **Step 2: Implement package input generation**

```ts
export interface GeneratedPackageInput {
  readonly input: Omit<PackageAdmissionInput, "signingKey" | "keyId">;
  readonly artifactRoot: string;
}

export function generatePackageInputs(args: {
  imported: SoftwareDevAgenticImportResult;
  materialized: MaterializedClosure;
  policy: SoftwareDevAgenticImportPolicy;
  sourceRepository: string;
}): readonly GeneratedPackageInput[];
```

Use module versions exactly. Artifact paths are relative to registry root. Dependencies come only from explicit policy and use exact or explicitly declared ranges.

- [ ] **Step 3: Add one-pass batch admission**

Avoid rescanning 152-package gate trees 152 times:

```ts
export async function admitPackageSet(args: {
  packages: readonly GeneratedPackageInput[];
  materialized: MaterializedClosure;
  signingKey: KeyObject;
  keyId: string;
}): Promise<readonly PackageAdmissionEnvelope[]>;
```

The batch API:

1. validates the complete package dependency graph once;
2. snapshots skills and agents views once;
3. runs procedure/context gates once;
4. collects each package artifact once;
5. binds relevant package mappings to the shared gate snapshot;
6. verifies modes;
7. signs deterministic envelopes in package-ID order.

Refactor existing `admitPackage` through shared internal primitives without weakening its public tests.

- [ ] **Step 4: Add complete-set failure tests**

Tests mutate one package at a time and prove the entire batch fails without partial envelope publication for:

- malicious agent context;
- broken procedure banner/tool grant;
- package dependency cycle;
- artifact byte mismatch;
- file mode mismatch;
- duplicate package ID;
- unexpected package kind/target root.

- [ ] **Step 5: Run focused verification**

```bash
pnpm --filter @cipherpol/admission test -- test/package-records.test.ts test/admission.test.ts
pnpm --filter @cipherpol/admission typecheck
```

Expected: package input and batch admission tests PASS.

---

### Task 5: Compose closure manifest and signed registry

**Files:**
- Create: `packages/admission/src/closure.ts`
- Create: `packages/admission/src/registry-signing.ts`
- Modify: `packages/admission/src/index.ts`
- Create: `packages/admission/test/closure.test.ts`

- [ ] **Step 1: Write failing closure tests**

Use a portable miniature corpus and generated key pair. Assert deterministic envelope equality and all mapping invariants.

- [ ] **Step 2: Implement closure manifest composition**

```ts
export function composeClosureManifest(args: {
  parity: ParityManifestV2;
  admissions: readonly PackageAdmissionEnvelope[];
  descriptors: readonly ImportedArtifactDescriptor[];
  admissionsRoot: string;
}): ClosureManifest;
```

Rules:

- one package mapping per non-MCP parity entry;
- 17 MCP mappings share the adapter package and use the imported exact tool name;
- deterministic parity-ID ordering;
- admission paths are traversal-free and deterministic;
- no registry package is unmapped.

- [ ] **Step 3: Implement registry index composition**

```ts
export function composeClosureRegistry(args: {
  admissions: readonly PackageAdmissionEnvelope[];
  closure: ClosureManifest;
}): RegistryIndex;
```

The index uses verified package records sorted by ID. `capabilityPacks` and `playbooks` are empty by approved design. Reject conflicting records for the same ID/version.

- [ ] **Step 4: Implement aggregate signing and verification**

```ts
export interface RegistrySigningOptions {
  readonly keyId: string;
  readonly keyPurpose: "fixture" | "production";
  readonly privateKey: KeyObject;
}

export function signRegistryEnvelope(
  registryIndex: RegistryIndex,
  closureManifest: ClosureManifest,
  options: RegistrySigningOptions,
): RegistryEnvelope;

export function verifyRegistryEnvelope(args: {
  envelope: unknown;
  trustedKeyId: string;
  trustedKeyPurpose: "fixture" | "production";
  publicKey: KeyObject;
  allowFixtureKeys: boolean;
}): RegistryEnvelope;
```

Sign canonical JSON of every field except `signature`. Bind `keyPurpose` and reject fixture-purpose keys unless explicitly allowed.

- [ ] **Step 5: Add tamper tests**

Reject registry package mutation, closure mapping mutation, key ID/purpose rewrite, wrong public key, missing admission, package/admission record mismatch, duplicate MCP capability, and unmapped package.

- [ ] **Step 6: Run focused verification**

```bash
pnpm --filter @cipherpol/admission test -- test/closure.test.ts
pnpm --filter @cipherpol/admission typecheck
```

Expected: closure and registry signing tests PASS.

---

### Task 6: Add signed loader and runtime mode enforcement

**Files:**
- Modify: `packages/resolver/package.json`
- Modify: `packages/resolver/src/digest.ts`
- Modify: `packages/resolver/src/load.ts`
- Modify: `packages/resolver/src/assemble.ts`
- Modify: `packages/resolver/src/index.ts`
- Create: `packages/resolver/test/digest.test.ts`
- Create: `packages/resolver/test/signed-registry.test.ts`
- Modify: `packages/resolver/test/assemble.test.ts`

- [ ] **Step 1: Write failing resolver digest tests**

Tests require code-point ordering, the contracts canonical digest, symlink/special-file rejection, and parity with admission-produced package digests.

- [ ] **Step 2: Replace resolver-local digest framing**

`digestDirectory` safely collects regular files and delegates framing to `canonicalArtifactDigest`. It must no longer use `localeCompare` or follow symlinks.

- [ ] **Step 3: Add additive signed loader**

```ts
export interface SignedRegistryTrust {
  readonly keyId: string;
  readonly keyPurpose: "fixture" | "production";
  readonly publicKey: KeyObject;
  readonly allowFixtureKeys: boolean;
}

export async function loadSignedRegistry(
  root: string,
  trust: SignedRegistryTrust,
  options?: { readonly verifyArtifacts?: boolean },
): Promise<{ root: string; index: RegistryIndex }>;
```

The loader verifies `registry-envelope.json`, then every closure-referenced admission envelope, package-record equality, and optionally every artifact digest/mode. Keep `loadRegistry` unchanged.

If importing `@cipherpol/admission` would create an architectural cycle, move aggregate verification into `@cipherpol/contracts` or a small verification module with no resolver dependency. Do not duplicate signing payload logic.

- [ ] **Step 4: Enforce declared modes during assembly**

After copying each mapped file, apply `mapping.mode` when present. Stage 1 mappings without mode retain current behavior.

- [ ] **Step 5: Add trust and assembly tests**

Tests cover valid fixture loading, fixture-key rejection without opt-in, aggregate tamper, admission tamper, artifact tamper, mode tamper, missing envelope, and runtime mode 0644/0755 application.

- [ ] **Step 6: Run focused verification**

```bash
pnpm --filter @cipherpol/resolver test
pnpm --filter @cipherpol/resolver typecheck
```

Expected: resolver tests PASS; existing Stage 1 tests remain green.

---

### Task 7: Add closure CLI, fixture key, and reproducibility proof

**Files:**
- Create: `packages/admission/src/reproducibility.ts`
- Modify: `packages/admission/src/cli.ts`
- Modify: `packages/admission/package.json`
- Modify: `packages/admission/test/cli.e2e.test.ts`
- Create: `packages/admission/test/reproducibility.test.ts`
- Create: `fixtures/software-dev-agentic/stage2-fixture-private.pem`
- Create: `fixtures/software-dev-agentic/stage2-fixture-public.pem`
- Create: `fixtures/software-dev-agentic/FIXTURE-KEY-NOTICE.txt`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Add explicit fixture key material**

Generate one Ed25519 key pair once. Commit it only under the fixture path. Add a notice stating:

```text
This private key is public test-fixture material.
It MUST NOT sign production packages or registries.
Production verification rejects keyPurpose=fixture unless explicitly enabled.
```

Use stable key ID:

```text
fixture.stage2.software-dev-agentic
```

- [ ] **Step 2: Implement tree snapshot comparison**

```ts
export interface ReproducibleTreeEntry {
  readonly path: string;
  readonly mode: number;
  readonly digest: string;
}

export async function compareClosureTrees(
  leftRoot: string,
  rightRoot: string,
): Promise<void>;
```

Collect only relative paths, normalized modes, and byte digests. Reject symlinks/special files. Report the first differing entry deterministically.

- [ ] **Step 3: Implement `close` command**

The command executes the approved publication order and builds twice in independent temporary directories. It atomically publishes only after both trees compare and the signed loader verifies the staged output.

Required options:

```text
--source-root
--source-revision
--policy
--private-key
--key-id
--output
--fixture
```

`--force` is required to replace existing output. Reject `--fixture` if the key purpose/key ID is not the approved fixture identity.

- [ ] **Step 4: Implement `verify-closure` command**

Required options:

```text
--registry-root
--public-key
--key-id
--fixture
```

`--verify-artifacts` enables full artifact byte/mode verification. The command is read-only.

- [ ] **Step 5: Add CLI scripts**

Root scripts:

```json
{
  "stage2:close": "pnpm --filter @cipherpol/admission cli close",
  "verify:closure": "pnpm --filter @cipherpol/admission cli verify-closure"
}
```

Do not hardcode workstation paths or keys into scripts.

- [ ] **Step 6: Add E2E tests**

Tests cover successful portable closure, deterministic rebuild, overwrite refusal/force, incomplete corpus no-publication, wrong key purpose, wrong key, artifact tamper, mode tamper, read-only verification, and no private-key leakage.

- [ ] **Step 7: Run focused verification**

```bash
pnpm --filter @cipherpol/admission test -- test/reproducibility.test.ts test/cli.e2e.test.ts
pnpm --filter @cipherpol/admission typecheck
```

Expected: closure CLI and reproducibility tests PASS.

---

### Task 8: Generate real fixture, review, verify, and commit atomically

**Files:**
- Generate: `fixtures/software-dev-agentic-registry/**`
- Modify tests only if the real fixture reveals a source-contract mismatch; do not weaken counts or gates.

- [ ] **Step 1: Run the real clean-room closure**

```bash
pnpm stage2:close -- \
  --source-root /Users/iqbal/projects/software-dev-agentic \
  --source-revision a8afa8dd0848833b72ef536e1258d5c27bb8e3fc \
  --policy fixtures/software-dev-agentic/import-policy.yaml \
  --private-key fixtures/software-dev-agentic/stage2-fixture-private.pem \
  --key-id fixture.stage2.software-dev-agentic \
  --output fixtures/software-dev-agentic-registry \
  --fixture \
  --force
```

Expected output includes:

```text
physical packages 152
parity mappings 168
cp1 MCP mappings 17
clean-room comparison identical
registry signature verified
```

- [ ] **Step 2: Verify the committed-shape fixture independently**

```bash
pnpm verify:closure -- \
  --registry-root fixtures/software-dev-agentic-registry \
  --public-key fixtures/software-dev-agentic/stage2-fixture-public.pem \
  --key-id fixture.stage2.software-dev-agentic \
  --fixture \
  --verify-artifacts
```

Expected: every aggregate/package/artifact/mode check passes.

- [ ] **Step 3: Run complete verification**

```bash
pnpm install --frozen-lockfile
SOFTWARE_DEV_AGENTIC_ROOT=/Users/iqbal/projects/software-dev-agentic \
  pnpm --filter @cipherpol/admission test
pnpm verify
SOFTWARE_DEV_AGENTIC_ROOT=/Users/iqbal/projects/software-dev-agentic \
SOFTWARE_DEV_AGENTIC_REVISION=a8afa8dd0848833b72ef536e1258d5c27bb8e3fc \
  pnpm verify:parity
pnpm smoke:local
```

Expected: strict typechecks pass, all tests pass except explicitly optional source integration when its environment is absent, parity remains 34/67/47/36/17 with 167 classified + taxonomy, and Stage 1 activates generation `sha256:78f0c0f902fe37f9dcaf52abc2761cc7a29c360a408459c4851cfe6ddb93778a`.

- [ ] **Step 4: Dispatch final reviews**

Parallel read-only reviews:

- code correctness and Stage 1 compatibility;
- security of source traversal, signing, fixture-key purpose, aggregate/package binding, and atomic publication;
- type/schema invariants;
- simplification pass after fixes.

Fix every Critical, High, or Important finding and rerun affected focused verification plus the full suite.

- [ ] **Step 5: Confirm atomic change set**

Verify tracked paths include source, tests, policy, fixture keys, generated registry, lockfile, and this plan. Exclude `node_modules`, temporary stages, consumer locks, and generated runtime directories.

- [ ] **Step 6: Commit Stage 2 closure atomically**

```bash
git add \
  .gitignore package.json pnpm-lock.yaml \
  packages/contracts packages/admission packages/resolver \
  fixtures/parity fixtures/software-dev-agentic fixtures/software-dev-agentic-registry \
  docs/superpowers/plans/2026-08-13-cipherpol-artifact-admission-and-parity.md \
  docs/superpowers/plans/2026-08-14-cipherpol-stage2-closure.md
git commit -m "feat: close Cipherpol Stage 2 artifact admission"
```

Do not include unrelated user files.

---

## Completion evidence

The handoff must report:

- source revision and module versions;
- physical package count by kind and total 152;
- parity mapping count 168 and cp1 mapping count 17;
- aggregate and per-package signature verification;
- clean-room byte/mode identity result;
- signed-loader artifact verification result;
- focused and workspace test/typecheck counts;
- Stage 1 smoke generation ID;
- final review verdicts;
- closure commit SHA;
- any approved deviation from this plan and its design reason.
