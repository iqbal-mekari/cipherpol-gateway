# Cipherpol Stage 2 Real-Corpus Closure Design

**Date:** 2026-08-14  
**Status:** Approved design  
**Source corpus:** `software-dev-agentic`  
**Source revision for the initial fixture:** `a8afa8dd0848833b72ef536e1258d5c27bb8e3fc`

## 1. Purpose

Stage 2 already provides source-faithful parity import, package admission, security and context gates, Ed25519 package envelopes, and parity verification. It does not yet turn the complete shipping `software-dev-agentic` corpus into immutable artifact directories, admit every package, compose a signed registry, or prove clean-room reproducibility.

This closure completes that missing executable path without introducing Stage 3 control-plane behavior. It preserves the existing Stage 1 filesystem registry and resolver interfaces.

## 2. Goals

The closure must:

1. materialize every build-selected authored artifact without behavior-changing rewrites;
2. generate schema-valid `PackageRecord` objects with measured canonical digests;
3. run the existing procedure, agent-context, security, compatibility, and dependency gates before signing;
4. persist one verified Ed25519 admission envelope per physical package;
5. compose and sign an aggregate registry containing the verified records;
6. map all 168 parity entries to admitted objects without omission or generic fallback;
7. prove two clean-room builds produce identical bytes, modes, records, and signatures;
8. keep Stage 1 `loadRegistry`, fixtures, and local activation behavior unchanged.

## 3. Non-goals

This closure does not:

- create PostgreSQL persistence, SSO, publication workflows, key-management infrastructure, or release-channel APIs;
- invent task-oriented capability packs or playbooks that have no approved authored source contract;
- deploy or operate the cp1 MCP server;
- introduce independent per-artifact release histories absent from the source marketplace;
- convert semantic composition edges into package installation dependencies;
- alter the existing Stage 1 local registry fixture or bootstrap plugin lifecycle.

## 4. Decisions

### 4.1 Trust architecture

Use a dual-signature model:

- each physical package retains its signed `PackageAdmissionEnvelope`;
- a separately signed registry envelope binds the complete registry index and closure manifest;
- a new signed-registry loader verifies the aggregate and referenced package envelopes before returning the existing `{ root, index }` resolver shape;
- the existing unsigned `loadRegistry` remains available for the Stage 1 local fixture.

This preserves per-package provenance and aggregate registry integrity without forcing a Stage 1 migration.

### 4.2 Imported package versions

Every imported package inherits its shipping module version:

- `cipherpol-aegis`: `16.0.1`;
- `cipherpol-9`: `13.14.0`;
- `cipherpol-1`: `0.2.0`.

Stage 3 may create independent package versions for later publications. The initial import does not invent version history.

### 4.3 Import metadata policy

Metadata absent from authored frontmatter comes from a checked-in, runtime-validated policy file at:

```text
fixtures/software-dev-agentic/import-policy.yaml
```

Initial shape:

```yaml
schemaVersion: cipherpol.import-policy/v1
modules:
  cipherpol-aegis:
    owner: mobile-platform
    packageVersion: module-version
    claudeCode: ">=2.1.0 <3.0.0"
    capabilities: [plugins]
  cipherpol-9:
    owner: mobile-platform
    packageVersion: module-version
    claudeCode: ">=2.1.0 <3.0.0"
    capabilities: [plugins]
  cipherpol-1:
    owner: mobile-platform
    packageVersion: module-version
    claudeCode: ">=2.1.0 <3.0.0"
    capabilities: [plugins]
packageDependencies: {}
```

Unknown modules, missing module policy, invalid compatibility ranges, unknown package IDs in dependency policy, malformed dependency ranges, and dependency cycles fail closed.

Parity `composition` and `dependencies` remain semantic relationships. They are not silently promoted to `PackageRecord.dependencies`. Only explicit acyclic installation dependencies in the policy enter the package DAG.

### 4.4 Fixture signing key

The reproducible Stage 2 fixture uses a committed Ed25519 fixture-only key pair. The key is identified by a stable fixture key ID and is never accepted as a production key.

Fixture acceptance requires an explicit `allowFixtureKeys` or equivalent fixture-mode option. Production verification defaults to rejecting fixture-purpose keys. Stage 3 replaces this fixture mechanism with managed signing keys and rotation policy.

## 5. Package boundaries

The closure uses one physical package per parity artifact where the artifact is independently shippable. Cyclic and self composition edges remain parity metadata and do not merge package identities.

### 5.1 Skill packages

The 67 skill-like entries materialize as:

- orchestrator → `PackageRecord.kind = skill`;
- platform contract → `PackageRecord.kind = skill`;
- internal procedure → `PackageRecord.kind = procedure`.

Each package copies the complete selected authored skill directory, not only `SKILL.md`. This includes `procedure.md`, scripts, prompts, test helpers, and other auxiliary regular files selected by the authored build root. Files are copied byte-for-byte.

Runtime targets preserve the shipping flat layout:

```text
skills/<frontmatter-name>/**
```

### 5.2 Agent packages

Each of the 47 authored agent Markdown files becomes one `agent` package targeting:

```text
agents/<basename>.md
```

The materializer rejects duplicate flattened basenames.

### 5.3 Reference packages

Each of the 36 selected Markdown references becomes one `reference` package. Targets reproduce the existing persona/reference output layout selected by the module build configuration.

### 5.4 Taxonomy package

The root `cipherpol.json` taxonomy becomes one `reference` package targeting:

```text
reference/cipherpol.json
```

It remains separately counted from the 36 Markdown references.

### 5.5 cp1 adapter package

The 17 cp1 MCP parity entries map to one shared `adapter` package. The adapter materializes the complete authored cp1 deploy/server selection required by the existing cp1 build contract rather than duplicating server source 17 times.

Each MCP parity entry maps to:

- the shared adapter package ID, version, and digest;
- its exact registered tool capability name.

The closure does not claim that this adapter is deployed or routed through the future gateway.

### 5.6 Expected physical package count

```text
67 skill/procedure packages
47 agent packages
36 reference packages
 1 taxonomy package
 1 cp1 adapter package
--------------------------
152 physical packages
```

The implementation must measure and assert this count from selected authored sources.

## 6. Deterministic materialization

### 6.1 Output layout

```text
fixtures/software-dev-agentic-registry/
  artifacts/<stable-package-id-path>/<module-version>/**
  admissions/<stable-package-id-path>/<module-version>.json
  registry-envelope.json
  fixture-public-key.pem
```

Stable package IDs are converted to traversal-free path segments without lossy basename flattening. Absolute source paths never enter persisted output.

### 6.2 Source safety

The materializer uses the importer’s canonical source-root checks:

- reject a symlink repository root;
- reject symlink path components, files, and directories;
- require every selected real path to remain under the canonical source root;
- reject sockets, devices, FIFOs, and other special files;
- read regular files with no-follow semantics and stable pre/post metadata checks;
- reject source replacement during materialization.

### 6.3 File modes

`PackageRecord.files` gains an optional normalized `mode` field:

- `0644` for an ordinary authored file;
- `0755` when the authored source has any executable bit.

Existing Stage 1 mappings remain valid without `mode`. Closure package mappings always declare it. Admission verifies the materialized mode, and runtime assembly applies the declared mode.

This removes host umask from the output while preserving executable helpers.

### 6.4 Canonical digest

Admission and resolver use one shared pure digest primitive over collected file records:

```text
sort by normalized relative path using Unicode code-point order
hash(relativePath + NUL + exact bytes + NUL)
```

Filesystem collection remains the responsibility of each trust boundary, but both feed the same canonical primitive. Resolver collection is changed to reject symlinks and special files and to use the same deterministic ordering.

File modes are signed through `PackageRecord.files`; the content digest remains compatible with the existing path-and-byte framing.

## 7. Admission flow

The closure constructs all package metadata and a complete `PackageDependencyNode[]` before signing any package.

For each package:

1. materialize into an admission-owned staged artifact directory;
2. derive explicit source-to-target mappings and normalized modes;
3. build `PackageAdmissionInput` from the import policy, module version, source revision, mappings, and explicit dependency policy;
4. collect complete flat `skills/` and `agents/` views from the same materialized package set;
5. run security scanning, compatibility validation, dependency DAG validation, `check_procedures`, and `check_agent_context`;
6. prove every agent/skill/procedure runtime mapping is byte-identical to the semantic gate snapshot;
7. compute the canonical digest from the exact scanned bytes;
8. sign the canonical admission payload with the fixture key;
9. immediately verify the envelope, artifact root, key identity, and declared modes;
10. persist the canonical envelope only after verification succeeds.

No package envelope is published when any package in the closure set fails a global gate.

## 8. Closure manifest

A new runtime-validated `cipherpol.closure/v1` manifest maps every `cipherpol.parity/v2` entry exactly once.

One-to-one package mappings contain:

```text
parity entry ID
package ID
package version
package digest
```

MCP mappings additionally contain the exact tool capability name and may share the same adapter package.

Validation requires:

- all 168 parity IDs are present exactly once;
- no unknown parity ID appears;
- every package mapping references a package record in the registry with matching version and digest;
- every persisted package record has at least one closure mapping;
- exactly 17 MCP mappings reference the cp1 adapter and use distinct registered capability names;
- taxonomy maps to the taxonomy reference package;
- no generic fallback or empty evidence qualifies as closure.

## 9. Signed registry envelope

The aggregate envelope uses a new schema version such as `cipherpol.registry-envelope/v1` and signs canonical JSON containing:

```text
schemaVersion
registryIndex
closureManifest
keyId
algorithm
keyPurpose
```

`registryIndex` remains a valid `cipherpol.registry/v1` object. Its `capabilityPacks` and `playbooks` arrays are empty for this closure because no approved source contract defines catalog composition. The existing Stage 1 local registry remains the activation fixture.

The fixture key purpose is signed so it cannot be rewritten into a production identity.

## 10. Signed registry loading

A new additive loader:

```text
loadSignedRegistry(root, trustStore, options)
```

performs:

1. parse the registry envelope;
2. resolve the trusted key independently from the envelope;
3. reject fixture keys unless fixture mode is explicit;
4. verify the aggregate signature;
5. validate registry and closure schemas;
6. load and verify every referenced package admission envelope;
7. require package record equality between envelope and registry;
8. optionally verify every artifact directory and normalized mode;
9. return the existing `{ root, index }` shape.

`resolveGeneration` and consumers do not learn a second registry model. Existing `loadRegistry` remains unchanged for Stage 1.

## 11. Atomic publication

The closure command builds under a sibling staging directory. Publication order is:

1. materialize all artifacts;
2. construct flat gate views;
3. admit and verify all packages;
4. compose registry and closure manifests;
5. sign and verify the aggregate;
6. run clean-room reproducibility comparison;
7. atomically replace the target fixture directory.

Failure removes the stage and leaves the previous published fixture unchanged. Existing output is not replaced unless the caller supplies explicit confirmation or `--force`.

## 12. Clean-room reproducibility

Two independent temporary builds use the same:

```text
source revision + import policy + fixture key
```

They must produce identical:

- relative paths;
- file bytes;
- normalized file modes;
- package records and canonical digests;
- package admission envelopes and signatures;
- closure manifest;
- aggregate registry envelope and signature.

Signed outputs contain no timestamps, machine paths, locale-dependent sorting, random IDs, process IDs, or temporary paths.

Comparison reports the first differing path, mode, or byte digest and fails without publication.

## 13. CLI

Extend the admission CLI with explicit closure operations:

```text
cipherpol-admission close \
  --source-root <software-dev-agentic> \
  --source-revision <git-sha> \
  --policy <import-policy.yaml> \
  --private-key <fixture-private-key.pem> \
  --key-id <fixture-key-id> \
  --output <registry-root> \
  --fixture \
  [--force]

cipherpol-admission verify-closure \
  --registry-root <registry-root> \
  --public-key <fixture-public-key.pem> \
  --key-id <fixture-key-id> \
  --fixture \
  [--verify-artifacts]
```

Private key bytes are never accepted as command arguments or printed. User/input/admission failures exit with the existing stable CLI error behavior; unexpected errors remain redacted.

## 14. Failure behavior

The closure fails closed on:

- source revision or module-version mismatch;
- source/build-config symlinks or special files;
- source replacement during collection;
- materialized target collisions;
- missing or invalid import policy;
- unknown package or parity IDs;
- unsupported package-kind/target-root combinations;
- malformed compatibility or dependency ranges;
- package dependency cycles;
- incomplete or mismatched gate views;
- parity omissions, duplicates, or dangling mappings;
- missing package envelopes;
- registry/package record mismatch;
- artifact bytes or modes that differ from signed records;
- untrusted, mismatched, rewritten, or disallowed-purpose keys;
- non-reproducible clean-room output.

Errors identify stable IDs and relative paths but never include key material, secret matches, or absolute source paths in persisted output.

## 15. Verification strategy

### 15.1 Unit contracts

Tests cover:

- import-policy parsing and missing-policy failures;
- full-directory skill materialization including auxiliary files;
- canonical package paths and collision rejection;
- normalized mode derivation and verification;
- shared canonical digest ordering;
- parity-to-package closure mapping;
- registry-envelope signing and trust-store lookup;
- fixture-key purpose restrictions.

### 15.2 End-to-end closure

Against the real source revision, tests and smoke commands prove:

1. 152 physical packages are materialized and admitted;
2. 168 parity entries are mapped exactly once;
3. all 17 cp1 tools map to the shared adapter with distinct tool names;
4. complete flat views pass procedure and agent-context checks;
5. all package envelopes verify;
6. the aggregate registry signature verifies;
7. registry, package, artifact, mode, key, and mapping tampering fail;
8. two clean-room builds are byte-identical and mode-identical;
9. the signed loader returns a valid `RegistryIndex`;
10. existing Stage 1 `pnpm verify` and `pnpm smoke:local` remain green.

### 15.3 Review gates

Before completion:

- code review checks source/build parity and resolver compatibility;
- security review checks key purpose, signature coverage, filesystem races, symlink handling, and aggregate/package consistency;
- no Critical, High, or Important finding remains unresolved.

## 16. Deliverables

```text
packages/contracts/                 additive closure/envelope/mode contracts
packages/admission/                 materializer, policy, composer, closure CLI
packages/resolver/                  shared digest use and signed loader
fixtures/software-dev-agentic/      import policy and fixture-only keys
fixtures/software-dev-agentic-registry/
  artifacts/
  admissions/
  registry-envelope.json
  fixture-public-key.pem
```

The generated registry fixture is source-derived and committed. Temporary build directories, private runtime state, and consumer locks remain ignored.

## 17. Acceptance boundary

Stage 2 closure is complete only when the committed fixture can be deleted, rebuilt twice from the pinned source revision with the fixture key, compared identically, verified through `loadSignedRegistry`, and shown not to break Stage 1 tests or local activation.
