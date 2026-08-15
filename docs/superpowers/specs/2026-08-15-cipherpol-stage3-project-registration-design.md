# Cipherpol Stage 3 Slice 2: Project Registration Design

**Date:** 2026-08-15
**Status:** Approved design
**Stage:** Stage 3 — Control plane and registry API (second vertical slice)

## 1. Purpose

Slice 1 delivered persisted registry objects, verifying ingestion, and generation resolution. This slice adds the roadmap's "project registration" item: a durable record of which projects are known to the control plane, referenced by later slices (activation records, per-project policy, audit) without those slices existing yet.

## 2. Non-goals

- SSO/session auth or any caller-identity check (still deferred; this slice reuses the exact same unauthenticated-endpoint boundary as Slice 1 — content is still the only thing verified, not the caller).
- Policy profiles, release-channel promotion workflow, revocation, activation records, operational dashboards (later slices).
- Any change to Stage 1/Stage 2 packages or Slice 1's ingestion/resolution/read modules.

## 3. Data model

Declarative schema addition, `supabase/schemas/003_projects.sql`:

```sql
create table public.projects (
  id text primary key,
  slug text not null unique,
  name text not null,
  default_channel text not null check (default_channel in ('canary', 'stable', 'pinned')),
  platforms text[] not null,
  owners text[] not null,
  registered_at timestamptz not null default now()
);
```

- `id` is the stable project identifier (matches `CipherpolManifest.project`); `slug` is a separate human-facing lookup key, since the design's Stage 1 `cipherpol.yaml` already carries a free-text `project` field that is not guaranteed URL-safe.
- RLS enabled; `service_role`-only grants; explicit `anon`/`authenticated` privilege revokes — identical posture to Slice 1's four tables.
- Registration is immutable-by-identity like packages: re-registering the same `id` with byte-identical content is a no-op; differing content is a fail-closed conflict.

## 4. API surface

```text
POST /projects
  body: { id, slug, name, defaultChannel, platforms, owners }
  → idempotent-by-identity insert (no-op if identical, 409 PROJECT_CONFLICT if differing)
  → 201 { id }

GET /projects/:slug   → ProjectRecord | 404
GET /projects         → ProjectRecord[]
```

No linkage to ingestion/resolution in this slice — registering a project does not gate or restrict `/registry/ingest` or `/generations/resolve` yet (that linkage is explicitly deferred to a later policy/authorization slice, to avoid conflating "which projects exist" with "which projects may do what").

## 5. Verification plan

Unit + live-local-Postgres integration tests mirroring Slice 1's exact conventions (unique per-test-run IDs, real Supabase client, no blanket table truncation): register, idempotent re-register, conflicting re-register rejected, list, get-by-slug, unknown-slug 404.

## 6. Acceptance boundary

Complete when: `projects` table exists with RLS/grants matching Slice 1's posture, the three routes are live and tested against the local Supabase instance, `supabase db advisors` is clean, and the full workspace `pnpm verify` plus Stage 1 smoke and Stage 2 parity remain unaffected.
