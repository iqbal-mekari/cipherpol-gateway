# Cipherpol Stage 3 Slice 1: Persisted Registry Core Design

**Date:** 2026-08-14
**Status:** Approved design
**Stage:** Stage 3 — Control plane and registry API (first vertical slice)

## 1. Purpose

Stage 3 (roadmap) bundles persistence, SSO, package publication/review, release channels, policy profiles, project registration, revocation, activation records, and operational APIs — too large for one plan, for the same reason Stage 2 split into artifact-admission-and-parity then closure.

This slice delivers the smallest working vertical: a PostgreSQL-backed control plane that ingests Stage 2 signed closures, persists them durably, and serves `resolveGeneration`-compatible reads over HTTP. It replaces the filesystem-only registry as a *consumable* data source without replacing Stage 1/2 trust logic, and without building SSO, review workflows, policy, or revocation yet.

## 2. Non-goals (explicit deferrals to later Stage 3 slices)

- SSO-authenticated identity, sessions, or end-user auth of any kind.
- Package publication/review workflow (admission still happens via the Stage 2 CLI).
- Release-channel promotion rules beyond storing which channel a snapshot belongs to.
- Policy profiles, project registration, revocation propagation, activation-record audit trail.
- Operational dashboards or a portal UI.
- Any change to Stage 1 (`loadRegistry`, `resolveGeneration`, `assembleRuntime`) or Stage 2 (`admission`, `contracts`) trust semantics — this slice is a consumer of those existing pure functions/verifiers, not a replacement.

## 3. Architecture

```text
cipherpol-admission close (existing, unchanged)
  → signed RegistryEnvelope + PackageAdmissionEnvelopes (existing Stage 2 output)
  → POST /registry/ingest  (new control-plane API)
      re-verifies every signature via @cipherpol/admission's
      verifyRegistryEnvelope/verifyAdmission — never trusts client-supplied rows
      persists packages/capability_packs/playbooks
      persists one immutable registry_snapshot row per channel, superseding the prior one
  → GET  /registry/packages, /registry/packages/:id/:version, /registry/snapshots/:channel
  → POST /generations/resolve
      loads the current snapshot for {channel}, reconstructs a RegistryIndex,
      calls the existing pure @cipherpol/resolver resolveGeneration(manifest, index, client)
```

New workspace package: `packages/control-plane` — Fastify HTTP service using `@supabase/supabase-js` with the **service-role key only**. No browser or end-user client talks to Supabase directly in this slice; the Fastify API is the sole trust boundary in front of Postgres.

## 4. Data model

Declarative schema under `supabase/schemas/`, generated migration via `supabase db pull`.

```sql
-- packages: one row per (id, version); superseded rows are never mutated or deleted
packages (
  id text, version text, kind text, digest text, owner text,
  source_revision text, artifact_path text,
  compatibility jsonb, dependencies text[], files jsonb, revoked boolean,
  primary key (id, version)
)

capability_packs (
  id text, version text, intents text[], platforms text[], orchestrator text,
  packages text[], playbooks text[], tool_bundle text, required_evidence text[], revoked boolean,
  primary key (id, version)
)

playbooks (
  id text, version text, owner text, platforms text[],
  guidance_packages text[], hook_packages text[], validator_packages text[],
  rules jsonb, revoked boolean,
  primary key (id, version)
)

registry_snapshots (
  id uuid primary key default gen_random_uuid(),
  channel text not null,
  source_revision text not null,
  key_id text not null,
  key_purpose text not null check (key_purpose in ('fixture', 'production')),
  registry_envelope jsonb not null,
  ingested_at timestamptz not null default now(),
  superseded_at timestamptz
)
```

- `packages`/`capability_packs`/`playbooks` are immutable per `(id, version)`: re-ingesting the same `(id, version)` is a no-op when the new row is byte-identical (`canonicalJson` equality) to the stored row, and a rejected `INGEST_CONFLICT` when it differs — never a silent overwrite.
- `registry_snapshots` is append-only. Ingesting a new closure for a channel sets `superseded_at = now()` on the prior current snapshot for that channel in the same transaction that inserts the new one — mirroring Stage 2's immutable-generation philosophy at the persistence layer.
- RLS is enabled on every table (Supabase security checklist requirement for any exposed schema). Policies grant `service_role` full access only; there is no `anon`/`authenticated` policy in this slice because there is no end-user auth yet.

## 5. API surface (this slice only)

```text
POST /registry/ingest
  body: { registryEnvelope, admissionEnvelopes: Record<admissionPath, envelope>, channel }
  → verifies aggregate + every referenced per-package envelope
  → persists packages/capability_packs/playbooks (idempotent per (id,version))
  → inserts new registry_snapshot, supersedes prior snapshot for that channel
  → 201 { snapshotId }

GET /registry/packages?channel=<channel>
GET /registry/packages/:id/:version
GET /registry/snapshots/:channel        (current, non-superseded)

POST /generations/resolve
  body: { manifest: CipherpolManifest, client: { claudeCodeVersion, capabilities } }
  → loads current snapshot for manifest.channel, reconstructs RegistryIndex
  → calls resolveGeneration(manifest, index, client) unchanged
  → 200 Generation | 4xx CipherpolError-mapped response
```

Ingestion is a **verifying persistence layer**, not a new trust root: it calls the exact same `verifyRegistryEnvelope`/`verifyAdmission` functions Stage 2's `verify-closure` CLI uses. A tampered or unsigned envelope is rejected before any row is written.

## 6. Verification plan

- Local Supabase stack (`supabase start`) for schema application and `supabase db advisors` (RLS/security lint) before committing the migration.
- Integration test: ingest the real committed Stage 2 closure fixture (152 packages, 168 mappings, `fixtures/software-dev-agentic-registry/`) through `/registry/ingest`, then call `/generations/resolve` with the existing `examples/mobile-talenta/cipherpol.yaml` manifest and diff the returned `Generation` against the equivalent local-fixture result from `resolveGeneration` for exact equivalence (same generation ID, same package set).
- Tamper tests: mutated registry envelope, mutated per-package envelope, digest mismatch, and revoked-key scenarios must all be rejected by `/registry/ingest` with no rows written (matching Stage 2's fail-closed contract).

## 7. Deliverables

```text
supabase/schemas/*.sql               declarative table definitions
supabase/migrations/*.sql            generated migration (via supabase db pull)
packages/control-plane/src/          Fastify API, Supabase client, ingestion/resolution handlers
packages/control-plane/test/         integration tests against local Supabase + real fixture
```

## 8. Acceptance boundary

This slice is complete when: the real Stage 2 closure fixture ingests successfully with signatures verified, a generation resolves from persisted state identically to the filesystem-based resolver, tamper/duplicate/revoked scenarios are rejected without persisting, and `supabase db advisors` reports no unresolved RLS/security findings.
