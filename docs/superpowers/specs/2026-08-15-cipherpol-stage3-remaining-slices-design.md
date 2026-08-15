# Cipherpol Stage 3 Remaining Slices Design

**Date:** 2026-08-15
**Status:** Approved design
**Stage:** Stage 3 — Control plane and registry API (slices 3–6, closing the stage)

Covers every remaining roadmap item for Stage 3: revocation, release-channel promotion,
policy profiles, activation records, SSO-authenticated publication + review, and
operational APIs. One doc because the six items share almost no code but do share
one constraint: none of them may regress Slice 1/2's already-tested ingest/read/
resolve behavior. Each section below is independently implementable against the
schema in §7, which is applied once, up front, before any feature code is written.

## 1. Revocation

`packages`/`capability_packs`/`playbooks` already carry `revoked boolean`; `resolve.ts`
already filters `!item.revoked`. Missing: a write path. Revocation is destructive (hides
a package from every consumer), so — unlike project registration — it cannot be an
open, unauthenticated write; that would be a trivial DoS. It reuses the same Ed25519
trust anchor as ingestion (`ControlPlaneTrustConfig`), because session auth (§5) doesn't
exist yet in Stage 3 and revocation cannot wait for it.

```ts
interface RevocationRequest {
  kind: "package" | "capabilityPack" | "playbook";
  id: string;
  version: string;
  action: "revoke" | "unrevoke";
  requestedAt: string; // ISO 8601
}
interface RevocationEnvelope {
  keyId: string;
  keyPurpose: "fixture" | "production";
  signature: string; // base64 Ed25519 over canonicalJson(revocation)
  revocation: RevocationRequest;
}
```

- New module `packages/control-plane/src/revocation.ts`. Verification mirrors
  `ingest.ts`: `keyId`/`keyPurpose` checked against `ControlPlaneTrustConfig` before any
  crypto; signature verified with `node:crypto`'s `verify(null, Buffer.from(canonicalJson(revocation)), publicKey, Buffer.from(signature, "base64"))` — the exact primitive
  `@cipherpol/admission` uses (`registry-signing.ts`), reimplemented locally because
  `verifyRegistryEnvelope`/`verifyAdmission` are hard-coupled to closure-shaped payloads.
- `requestedAt` must be within 5 minutes of server time (reject otherwise, `INVALID_ENVELOPE`) — a minimal replay-window bound; there is no nonce store yet.
- `POST /revocations` with a `RevocationEnvelope` body → `{ id, version, revoked }`.
  404 if `(kind, id, version)` does not exist.
- No change to `resolve.ts`/`resolveGeneration`/registry reads — they already honor `revoked`.

## 2. Release-channel promotion

`ingestClosure`'s `channel` argument is independent of the signed `registryEnvelope` —
a signed closure isn't bound to one channel. Promotion = read the current snapshot's
stored envelope for the source channel, then call the existing `ingestClosure` again for
the target channel. No new verification code, but it requires the admission envelopes
that were part of the original ingest to still be available — today they are only used
transiently and never persisted (§7 adds `registry_snapshots.admission_envelopes`).

```text
POST /generations/promote
  body: { fromChannel: string, toChannel: string }
  → 404 UNKNOWN_CHANNEL if fromChannel has no current snapshot
  → re-ingesting an already-promoted generation into a channel that already has it
    is a no-op, by ingestClosure's existing idempotency
  → 200 { snapshotId }
```

New module `packages/control-plane/src/promotion.ts`: `promoteGeneration(client, trust, { fromChannel, toChannel })` — calls `getCurrentSnapshot` then `ingestClosure` with the retrieved envelope and its persisted admission envelopes.

## 3. Policy profiles

A policy profile constrains which platforms/capability packs a project's resolutions
may use. This is new project-scoped enforcement, not a Stage 1 change.

```sql
create table public.policy_profiles (
  id text primary key,
  name text not null,
  allowed_platforms text[], -- null = unrestricted
  allowed_capability_packs text[], -- null = unrestricted
  created_at timestamptz not null default now()
);
```

`projects.policy_profile_id text references public.policy_profiles(id)`, nullable
(a project with no profile is unrestricted — matches today's behavior, so existing
Slice 2 projects and tests are unaffected).

Enforcement point: a **new** control-plane-only wrapper, `resolveGenerationForProject`
in `packages/control-plane/src/generations.ts`, takes an optional `projectId`. It calls
the existing (unmodified) Stage 1 `resolveGeneration` first, then — only if `projectId`
is given and the project has a `policy_profile_id` — checks the resolved capability
pack's `id` against `allowed_capability_packs` and its `platforms` against
`allowed_platforms`. Violation → new error code `POLICY_VIOLATION` (422), not a silent
filter; the manifest resolves fine on its own; a policy violation means "resolves, but
this project isn't allowed to activate what it resolved to." `POST /generations/resolve`
accepts an optional `projectId` field (absent = today's unrestricted behavior, byte-for-
byte unchanged — this is why Slice 1/2's tests keep passing untouched).

`POST /policy-profiles` (idempotent-by-identity like projects), `GET /policy-profiles/:id`.

## 4. Activation records

An audit trail: "this client activated this generation, at this time." Not a security
boundary — it is client-reported telemetry, exactly as trustworthy as any other
unauthenticated read/write in this stage (explicitly not gating anything; a forged
activation record cannot cause a client to run anything it didn't already resolve).

```sql
create table public.activation_records (
  id uuid primary key default gen_random_uuid(),
  project_id text references public.projects(id),
  channel text not null,
  snapshot_id uuid not null references public.registry_snapshots(id),
  generation_digest text not null,
  claude_code_version text not null,
  capabilities text[] not null default '{}',
  activated_at timestamptz not null default now()
);
```

`POST /activations` (fire-and-forget insert, 201 `{ id }`), `GET /activations?projectId=&channel=&limit=` (most recent first, default limit 50, max 500).

## 5. SSO-authenticated publication + review

Uses Supabase Auth (GoTrue), already running as part of the local stack — real users,
real JWTs, genuinely testable locally without a third-party IdP. Scope, stated honestly:

- **In scope:** a new auth-verification module that validates a caller-supplied Supabase
  session JWT (`Authorization: Bearer <token>`) against the project's JWT secret,
  extracting the authenticated user's `sub`; an *optional* `Authorization` header on
  `POST /registry/ingest` that, when present and valid, records the publishing user's
  id on the snapshot (`registry_snapshots.published_by`, nullable); a new
  `POST /generations/:snapshotId/reviews` endpoint requiring a *valid* session (this one
  is not optional — an unauthenticated caller cannot record a review) that inserts an
  approve/reject audit record.
- **Explicitly deferred, not built this slice:** making review a hard gate that blocks a
  snapshot from becoming "current" until approved. Today, `ingestClosure` synchronously
  supersedes the channel's current snapshot the moment a validly signed closure arrives
  — every Slice 1/2/3 test and the `smoke:local` script depend on that synchronous
  behavior. Flipping to gated activation is a breaking contract change to `ingestClosure`
  that needs its own design and its own migration of every caller (the resolver CLI,
  the smoke script, and every existing ingest test) — exactly the kind of change the
  "clean cutover" rule says must not be done partially or silently. Doing it honestly
  inside this slice would mean rewriting Slice 1–3's already-shipped, tested ingestion
  contract; doing it dishonestly would mean a fake "reviewed" flag nothing enforces.
  Neither is acceptable, so this slice ships identity-bound publication and a real,
  queryable review audit trail, and leaves hard-gated activation as a named follow-on
  decision for whoever picks up Stage 3 next (or a fast-follow slice, if wanted, once
  this is reviewed).

```sql
create table public.snapshot_reviews (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.registry_snapshots(id),
  reviewer_user_id uuid not null,
  decision text not null check (decision in ('approved', 'rejected')),
  comment text,
  reviewed_at timestamptz not null default now()
);
```

New module `packages/control-plane/src/auth.ts`: `verifySessionToken(env, authorizationHeader): Promise<{ userId: string } | undefined>` — decodes and verifies the JWT's HMAC signature against `env.SUPABASE_JWT_SECRET` (new required env var; local Supabase already exposes this — `supabase status -o json` includes it), checks `exp`, and returns `undefined` (not a thrown error) when the header is absent, letting `POST /registry/ingest` treat auth as optional per the design above. `POST /generations/:snapshotId/reviews` throws `ControlPlaneError("UNAUTHENTICATED", 401, ...)` when `verifySessionToken` returns `undefined`.

## 6. Operational APIs

Minimal, read-only, low-risk: `GET /health` (200 `{ status: "ok" }`, no DB round-trip —
process liveness only), `GET /health/ready` (200 only if a DB round-trip succeeds, 503
otherwise — separates liveness from readiness per standard practice), `GET /registry/ingest-history?channel=&limit=` (lists `registry_snapshots` metadata — id, channel, sourceRevision, keyId, publishedBy, ingestedAt — newest first, no envelope body, to keep payloads small).

## 7. Consolidated schema changes

Applied once, before any feature code, as `supabase/schemas/004_stage3_remaining.sql`:

```sql
alter table public.registry_snapshots add column admission_envelopes jsonb not null default '{}'::jsonb;
alter table public.registry_snapshots add column published_by uuid;

create table public.policy_profiles (...); -- §3
alter table public.projects add column policy_profile_id text references public.policy_profiles(id);

create table public.activation_records (...); -- §4
create table public.snapshot_reviews (...); -- §5
```

All four new/altered tables get the same RLS + `service_role`-only-grant +
`REVOKE ALL FROM anon, authenticated` posture as every existing table (Slice 2's review
caught a real gap here — the migration itself must carry the unconditional `REVOKE`,
not just the schema file).

## 8. Verification plan

Each section's endpoints get live-local-Postgres tests in their own package test file,
following the exact conventions already established (per-test unique IDs, real Supabase
client, `t.after` cleanup of only that test's own rows, HTTP-level tests via
`buildServer`/`app.inject`). No section may change the observable behavior of an
existing, already-tested endpoint — `POST /generations/resolve` without `projectId` and
`POST /registry/ingest` without `Authorization` must behave byte-for-byte as before.

## 9. Acceptance boundary

Complete when every endpoint above is live and tested against the local Supabase
instance, `supabase db advisors` is clean, and the full workspace `pnpm verify` plus
Stage 1 smoke and Stage 2/3 parity remain unaffected.
