# Cipherpol Stage 3 Slice 1: Persisted Registry Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking. Workers must not run project-wide validation; the orchestrator runs focused checks after each dependency wave and the complete suite once at the end.

**Goal:** Persist registry objects and Stage 2 signed closures in Supabase-managed PostgreSQL, ingest with full signature re-verification, and serve `resolveGeneration`-compatible reads over a Fastify HTTP API.

**Architecture:** New workspace package `packages/control-plane` runs a Fastify service backed by `@supabase/supabase-js` (service-role key, server-side only). Ingestion re-verifies every Stage 2 signature via `@cipherpol/admission` before writing rows. Generation resolution reconstructs a `RegistryIndex` from the current snapshot and calls the existing pure `@cipherpol/resolver` `resolveGeneration` unchanged.

**Tech Stack:** Supabase CLI (declarative schema), PostgreSQL, Fastify 5, `@supabase/supabase-js`, TypeScript 5, Zod 3 (reuse `@cipherpol/contracts`), Node test runner via `tsx --test`.

**Approved design:** `docs/superpowers/specs/2026-08-14-cipherpol-stage3-persisted-registry-core-design.md`

---

## Preconditions (verified)

```text
supabase CLI: 2.111.0 (>= 2.81.3, supports db advisors)
Docker: running
```

---

## File map

```text
supabase/config.toml                        Supabase local project config
supabase/schemas/001_packages.sql           packages / capability_packs / playbooks tables + RLS
supabase/schemas/002_registry_snapshots.sql registry_snapshots table + RLS
supabase/migrations/<generated>.sql         generated migration (via supabase db pull)

packages/control-plane/package.json
packages/control-plane/tsconfig.json
packages/control-plane/src/env.ts           service-role Supabase client construction
packages/control-plane/src/errors.ts        typed HTTP-mappable errors
packages/control-plane/src/canonical-registry.ts  RegistryIndex reconstruction from DB rows
packages/control-plane/src/ingest.ts        verify + persist a signed closure
packages/control-plane/src/registry-reads.ts  package/snapshot read queries
packages/control-plane/src/generations.ts   resolve-generation handler
packages/control-plane/src/server.ts        Fastify app wiring
packages/control-plane/src/index.ts         exports
packages/control-plane/test/ingest.test.ts
packages/control-plane/test/registry-reads.test.ts
packages/control-plane/test/generations.test.ts
packages/control-plane/test/server.e2e.test.ts

package.json                                 workspace scripts (db:start, db:advisors, control-plane test)
pnpm-workspace.yaml                           unchanged (packages/* already matches)
```

---

### Task 1: Scaffold Supabase project and declarative schema

**Files:**
- Create: `supabase/config.toml`
- Create: `supabase/schemas/001_packages.sql`
- Create: `supabase/schemas/002_registry_snapshots.sql`
- Create: `supabase/migrations/<generated>.sql`
- Modify: `package.json`

- [ ] **Step 1: Initialize the Supabase project**

Run:

```bash
supabase init
```

Expected: creates `supabase/config.toml` and `supabase/.gitignore`. Confirm `config.toml` does not hardcode a remote project ref (local-only for this slice).

- [ ] **Step 2: Write declarative schema for registry objects**

Create `supabase/schemas/001_packages.sql`:

```sql
create table public.packages (
  id text not null,
  version text not null,
  kind text not null,
  digest text not null,
  owner text not null,
  source_revision text not null,
  artifact_path text not null,
  compatibility jsonb not null,
  dependencies text[] not null default '{}',
  files jsonb not null,
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (id, version)
);

alter table public.packages enable row level security;

create policy "service role full access to packages"
  on public.packages
  for all
  to service_role
  using (true)
  with check (true);

create table public.capability_packs (
  id text not null,
  version text not null,
  intents text[] not null,
  platforms text[] not null,
  orchestrator text not null,
  packages text[] not null,
  playbooks text[] not null default '{}',
  tool_bundle text,
  required_evidence text[] not null default '{}',
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (id, version)
);

alter table public.capability_packs enable row level security;

create policy "service role full access to capability_packs"
  on public.capability_packs
  for all
  to service_role
  using (true)
  with check (true);

create table public.playbooks (
  id text not null,
  version text not null,
  owner text not null,
  platforms text[] not null,
  guidance_packages text[] not null default '{}',
  hook_packages text[] not null default '{}',
  validator_packages text[] not null default '{}',
  rules jsonb not null,
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (id, version)
);

alter table public.playbooks enable row level security;

create policy "service role full access to playbooks"
  on public.playbooks
  for all
  to service_role
  using (true)
  with check (true);
```

Create `supabase/schemas/002_registry_snapshots.sql`:

```sql
create table public.registry_snapshots (
  id uuid primary key default gen_random_uuid(),
  channel text not null,
  source_revision text not null,
  key_id text not null,
  key_purpose text not null check (key_purpose in ('fixture', 'production')),
  registry_envelope jsonb not null,
  ingested_at timestamptz not null default now(),
  superseded_at timestamptz
);

alter table public.registry_snapshots enable row level security;

create policy "service role full access to registry_snapshots"
  on public.registry_snapshots
  for all
  to service_role
  using (true)
  with check (true);

create unique index registry_snapshots_current_per_channel
  on public.registry_snapshots (channel)
  where superseded_at is null;
```

- [ ] **Step 3: Start the local stack and apply the schema**

Run:

```bash
supabase start
```

Expected: local Postgres, Auth, and API containers start; prints local `anon`/`service_role` keys and API URL.

Run:

```bash
supabase db push --local
```

Expected: schema files applied to the local database with no errors. If `db push` is unavailable for declarative schemas in this CLI version, use `supabase db reset` after placing schema files, which applies `supabase/schemas/*.sql` in file order.

- [ ] **Step 4: Run security advisors**

Run:

```bash
supabase db advisors
```

Expected: no unresolved RLS/security findings for the four new tables. If findings appear, fix them in the schema files and re-run before proceeding.

- [ ] **Step 5: Generate the migration**

Run:

```bash
supabase db pull registry_core --local --yes
```

Expected: one migration file created under `supabase/migrations/` capturing the four tables, RLS policies, and unique index.

- [ ] **Step 6: Add workspace scripts**

Add to root `package.json`:

```json
{
  "db:start": "supabase start",
  "db:stop": "supabase stop",
  "db:reset": "supabase db reset --local",
  "db:advisors": "supabase db advisors"
}
```

- [ ] **Step 7: Commit**

```bash
git add supabase package.json
git commit -m "feat: scaffold Supabase registry core schema"
```

Expected: local stack applies cleanly from a fresh `supabase db reset --local`.

---

### Task 2: Build the control-plane package skeleton and Supabase client

**Files:**
- Create: `packages/control-plane/package.json`
- Create: `packages/control-plane/tsconfig.json`
- Create: `packages/control-plane/src/env.ts`
- Create: `packages/control-plane/src/errors.ts`
- Create: `packages/control-plane/src/index.ts`
- Create: `packages/control-plane/test/env.test.ts`

- [ ] **Step 1: Write failing environment tests**

Create `packages/control-plane/test/env.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { loadControlPlaneEnv } from "../src/index.js";

test("requires explicit Supabase URL and service-role key", () => {
  assert.throws(
    () => loadControlPlaneEnv({}),
    (error: unknown) => error instanceof Error && /SUPABASE_URL/.test(error.message),
  );
});

test("rejects a publishable/anon key passed as the service-role key", () => {
  assert.throws(
    () => loadControlPlaneEnv({
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_abc123",
    }),
    (error: unknown) => error instanceof Error && /service-role/.test(error.message),
  );
});

test("loads a valid explicit environment", () => {
  const env = loadControlPlaneEnv({
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc123",
    PORT: "4100",
  });
  assert.equal(env.supabaseUrl, "http://127.0.0.1:54321");
  assert.equal(env.port, 4100);
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @cipherpol/control-plane test` — expected FAIL, package does not exist.

- [ ] **Step 3: Create package metadata**

Create `packages/control-plane/package.json`:

```json
{
  "name": "@cipherpol/control-plane",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "tsx --test test/**/*.test.ts",
    "start": "tsx src/server.ts"
  },
  "dependencies": {
    "@cipherpol/admission": "workspace:*",
    "@cipherpol/contracts": "workspace:*",
    "@cipherpol/resolver": "workspace:*",
    "@supabase/supabase-js": "^2.45.0",
    "fastify": "^5.1.0",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/node": "^24.3.0",
    "tsx": "^4.20.5",
    "typescript": "^5.9.2"
  }
}
```

Create `packages/control-plane/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["test/fixtures/**"]
}
```

- [ ] **Step 4: Implement explicit environment loading**

Create `packages/control-plane/src/env.ts`:

```ts
import { z } from "zod";

function isServiceRoleKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) return true;
  if (key.startsWith("sb_publishable_")) return false;
  const segments = key.split(".");
  if (segments.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8")) as { role?: unknown };
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

const envSchema = z.object({
  SUPABASE_URL: z.string().url("SUPABASE_URL must be an explicit URL"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).refine(
    isServiceRoleKey,
    "SUPABASE_SERVICE_ROLE_KEY must be the service-role key, not a publishable/anon key",
  ),
  PORT: z.string().regex(/^\d+$/).default("4100"),
});

export interface ControlPlaneEnv {
  readonly supabaseUrl: string;
  readonly supabaseServiceRoleKey: string;
  readonly port: number;
}

export function loadControlPlaneEnv(source: Record<string, string | undefined>): ControlPlaneEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid control-plane environment (${missing}): ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return {
    supabaseUrl: parsed.data.SUPABASE_URL,
    supabaseServiceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
    port: Number(parsed.data.PORT),
  };
}
```

`isServiceRoleKey` accepts the new `sb_secret_`-prefixed format directly, rejects the new `sb_publishable_`-prefixed format directly, and for legacy JWT-format keys decodes the payload segment and checks the `role` claim equals `service_role` rather than guessing from a string prefix. Confirm this matches the exact key formats `supabase start`/`supabase status -o json` emits for CLI 2.111.0 before finalizing; adjust only if the observed local `service_role`/`anon` values do not decode as expected.

- [ ] **Step 5: Add typed control-plane errors**

Create `packages/control-plane/src/errors.ts`:

```ts
export type ControlPlaneErrorCode =
  | "INVALID_ENVELOPE"
  | "INGEST_CONFLICT"
  | "UNKNOWN_CHANNEL"
  | "RESOLUTION_FAILED";

export class ControlPlaneError extends Error {
  constructor(
    readonly code: ControlPlaneErrorCode,
    readonly httpStatus: number,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}
```

- [ ] **Step 6: Export module**

Create `packages/control-plane/src/index.ts`:

```ts
export * from "./env.js";
export * from "./errors.js";
```

- [ ] **Step 7: Run focused verification**

```bash
pnpm install
pnpm --filter @cipherpol/control-plane test
pnpm --filter @cipherpol/control-plane typecheck
```

Expected: 3 tests PASS; typecheck exits zero.

- [ ] **Step 8: Commit**

```bash
git add packages/control-plane pnpm-lock.yaml
git commit -m "chore: scaffold Cipherpol control-plane package"
```

---

### Task 3: Implement verifying ingestion

**Files:**
- Create: `packages/control-plane/src/canonical-registry.ts`
- Create: `packages/control-plane/src/ingest.ts`
- Create: `packages/control-plane/test/ingest.test.ts`
- Modify: `packages/control-plane/src/index.ts`

- [ ] **Step 1: Write failing ingestion tests**

Create `packages/control-plane/test/ingest.test.ts` covering: successful ingestion of a small generated closure (reuse the same portable fixture pattern as `packages/admission/test/closure.test.ts` — generate a miniature signed closure with `@cipherpol/admission`'s `materializeClosure`/`admitPackageSet`/`composeClosureManifest`/`composeClosureRegistry`/`signRegistryEnvelope`); tampered aggregate signature rejected with zero rows written; tampered per-package envelope rejected with zero rows written; re-ingesting an identical `(id, version)` package is a no-op; re-ingesting a changed `(id, version)` package is rejected with `INGEST_CONFLICT`; ingesting a new closure for the same channel supersedes the prior snapshot.

Use a real local Supabase instance (`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` from `supabase start`, read via `process.env` with a clear skip message when unset) — no mocking of Postgres; truncate the four tables in a `beforeEach`/`afterEach` hook via direct `supabase-js` calls scoped to this test's own inserted IDs (never a blanket `TRUNCATE` that could affect a shared dev database) — use a unique test-run channel/ID prefix instead of a blanket truncate to keep the test safe to run against a shared local instance.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @cipherpol/control-plane test
```

Expected: FAIL, `ingestClosure` is absent.

- [ ] **Step 3: Implement RegistryIndex reconstruction**

Create `packages/control-plane/src/canonical-registry.ts`:

```ts
import type { RegistryIndex } from "@cipherpol/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function loadCurrentRegistryIndex(
  client: SupabaseClient,
  channel: string,
): Promise<{ index: RegistryIndex; snapshotId: string } | undefined> {
  const { data, error } = await client
    .from("registry_snapshots")
    .select("id, registry_envelope")
    .eq("channel", channel)
    .is("superseded_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return undefined;
  const envelope = data.registry_envelope as { registryIndex: RegistryIndex };
  return { index: envelope.registryIndex, snapshotId: data.id as string };
}
```

- [ ] **Step 4: Implement verifying ingestion**

Create `packages/control-plane/src/ingest.ts`:

```ts
import { createPublicKey } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalJson } from "@cipherpol/contracts";
import { verifyAdmission, verifyRegistryEnvelope } from "@cipherpol/admission";
import { ControlPlaneError } from "./errors.js";

export interface IngestClosureInput {
  readonly registryEnvelope: unknown;
  readonly admissionEnvelopes: Readonly<Record<string, unknown>>;
  readonly channel: string;
  readonly trustedKeyId: string;
  readonly trustedKeyPurpose: "fixture" | "production";
  readonly trustedPublicKeyPem: string;
  readonly allowFixtureKeys: boolean;
}

export async function ingestClosure(client: SupabaseClient, input: IngestClosureInput): Promise<{ snapshotId: string }> {
  const publicKey = createPublicKey(input.trustedPublicKeyPem);
  let envelope;
  try {
    envelope = verifyRegistryEnvelope({
      envelope: input.registryEnvelope,
      trustedKeyId: input.trustedKeyId,
      trustedKeyPurpose: input.trustedKeyPurpose,
      publicKey,
      allowFixtureKeys: input.allowFixtureKeys,
    });
  } catch (error) {
    throw new ControlPlaneError("INVALID_ENVELOPE", 422, "Registry envelope failed verification", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  for (const mapping of envelope.closureManifest.mappings) {
    const admissionEnvelope = input.admissionEnvelopes[mapping.admissionPath];
    if (admissionEnvelope === undefined) {
      throw new ControlPlaneError("INVALID_ENVELOPE", 422, `Missing admission envelope for ${mapping.admissionPath}`);
    }
    try {
      await verifyAdmission(admissionEnvelope, {
        trustedKeyId: input.trustedKeyId,
        trustedPublicKey: publicKey,
        allowFixtureKeys: input.allowFixtureKeys,
      });
    } catch (error) {
      throw new ControlPlaneError("INVALID_ENVELOPE", 422, `Admission envelope failed verification: ${mapping.admissionPath}`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const record of envelope.registryIndex.packages) {
    const { data: existing, error: readError } = await client
      .from("packages")
      .select("id, version, kind, digest, owner, source_revision, artifact_path, compatibility, dependencies, files, revoked")
      .eq("id", record.id)
      .eq("version", record.version)
      .maybeSingle();
    if (readError) throw readError;
    if (existing) {
      const { id, version, ...rest } = existing as Record<string, unknown>;
      if (canonicalJson(rest) !== canonicalJson({
        kind: record.kind, digest: record.digest, owner: record.owner,
        source_revision: record.sourceRevision, artifact_path: record.artifactPath,
        compatibility: record.compatibility, dependencies: record.dependencies,
        files: record.files, revoked: record.revoked,
      })) {
        throw new ControlPlaneError("INGEST_CONFLICT", 409, `Package ${id}@${String(version)} already exists with different content`);
      }
      continue;
    }
    const { error: insertError } = await client.from("packages").insert({
      id: record.id, version: record.version, kind: record.kind, digest: record.digest,
      owner: record.owner, source_revision: record.sourceRevision, artifact_path: record.artifactPath,
      compatibility: record.compatibility, dependencies: record.dependencies,
      files: record.files, revoked: record.revoked,
    });
    if (insertError) throw insertError;
  }

  const { error: supersedeError } = await client
    .from("registry_snapshots")
    .update({ superseded_at: new Date().toISOString() })
    .eq("channel", input.channel)
    .is("superseded_at", null);
  if (supersedeError) throw supersedeError;

  const { data: inserted, error: insertSnapshotError } = await client
    .from("registry_snapshots")
    .insert({
      channel: input.channel,
      source_revision: envelope.closureManifest.sourceRevision,
      key_id: envelope.keyId,
      key_purpose: envelope.keyPurpose,
      registry_envelope: envelope,
    })
    .select("id")
    .single();
  if (insertSnapshotError) throw insertSnapshotError;

  return { snapshotId: inserted.id as string };
}
```

Add capability-pack and playbook persistence following the identical existing/conflict/insert pattern as `packages`, inside the same function before the snapshot insert.

- [ ] **Step 5: Update exports**

Add `export * from "./ingest.js"; export * from "./canonical-registry.js";` to `packages/control-plane/src/index.ts`.

- [ ] **Step 6: Run focused verification**

```bash
supabase start
SUPABASE_URL=$(supabase status -o json | jq -r '.API_URL') \
SUPABASE_SERVICE_ROLE_KEY=$(supabase status -o json | jq -r '.SERVICE_ROLE_KEY') \
  pnpm --filter @cipherpol/control-plane test
pnpm --filter @cipherpol/control-plane typecheck
```

Expected: all ingestion tests PASS against the real local Postgres instance; typecheck exits zero.

- [ ] **Step 7: Commit**

```bash
git add packages/control-plane
git commit -m "feat: verify and persist Cipherpol signed closures"
```

---

### Task 4: Implement registry reads and generation resolution API

**Files:**
- Create: `packages/control-plane/src/registry-reads.ts`
- Create: `packages/control-plane/src/generations.ts`
- Create: `packages/control-plane/src/server.ts`
- Create: `packages/control-plane/test/registry-reads.test.ts`
- Create: `packages/control-plane/test/generations.test.ts`
- Create: `packages/control-plane/test/server.e2e.test.ts`
- Modify: `packages/control-plane/src/index.ts`

- [ ] **Step 1: Write failing read/resolve/e2e tests**

`registry-reads.test.ts`: list packages by channel, get one package by id/version, get current snapshot for a channel, 404-equivalent `undefined` for an unknown channel.

`generations.test.ts`: resolve a generation against a persisted snapshot and assert it matches calling `resolveGeneration` directly against the equivalent in-memory `RegistryIndex`; unresolvable manifest maps to `RESOLUTION_FAILED`.

`server.e2e.test.ts`: boot the Fastify app against the local Supabase instance, `POST /registry/ingest` a generated closure, `GET /registry/packages`, `GET /registry/snapshots/:channel`, `POST /generations/resolve`, and assert exact response shapes and status codes; assert `/registry/ingest` with a tampered envelope returns 422 and leaves prior data unchanged.

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @cipherpol/control-plane test
```

Expected: FAIL, handlers/server absent.

- [ ] **Step 3: Implement reads**

Create `packages/control-plane/src/registry-reads.ts` with `listPackages(client, channel)`, `getPackage(client, id, version)`, `getCurrentSnapshot(client, channel)` built directly on `supabase-js` queries against the schema from Task 1, returning types inferred from `@cipherpol/contracts`.

- [ ] **Step 4: Implement generation resolution handler**

Create `packages/control-plane/src/generations.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { CipherpolError, resolveGeneration, type Client } from "@cipherpol/resolver";
import type { CipherpolManifest } from "@cipherpol/contracts";
import { loadCurrentRegistryIndex } from "./canonical-registry.js";
import { ControlPlaneError } from "./errors.js";

export async function resolveGenerationFromRegistry(
  client: SupabaseClient,
  manifest: CipherpolManifest,
  resolverClient: Client,
) {
  const current = await loadCurrentRegistryIndex(client, manifest.channel);
  if (!current) {
    throw new ControlPlaneError("UNKNOWN_CHANNEL", 404, `No registry snapshot for channel ${manifest.channel}`);
  }
  try {
    return resolveGeneration(manifest, current.index, resolverClient);
  } catch (error) {
    if (error instanceof CipherpolError) {
      throw new ControlPlaneError("RESOLUTION_FAILED", 422, error.message, { code: error.code });
    }
    throw error;
  }
}
```

- [ ] **Step 5: Wire the Fastify server**

Create `packages/control-plane/src/server.ts` exposing `buildServer(client): FastifyInstance` with the four routes from the design's API surface, mapping `ControlPlaneError`/`CipherpolError` to their declared HTTP status codes and a stable JSON error body `{ code, message }`; unexpected errors return 500 with a redacted body (no stack trace, no internal details).

- [ ] **Step 6: Update exports**

Add the three new modules to `packages/control-plane/src/index.ts`.

- [ ] **Step 7: Run focused verification**

```bash
SUPABASE_URL=$(supabase status -o json | jq -r '.API_URL') \
SUPABASE_SERVICE_ROLE_KEY=$(supabase status -o json | jq -r '.SERVICE_ROLE_KEY') \
  pnpm --filter @cipherpol/control-plane test
pnpm --filter @cipherpol/control-plane typecheck
```

Expected: all tests PASS; typecheck exits zero.

- [ ] **Step 8: Commit**

```bash
git add packages/control-plane
git commit -m "feat: serve Cipherpol registry reads and generation resolution"
```

---

### Task 5: Prove real-fixture equivalence and finalize

**Files:**
- Create: `packages/control-plane/test/real-fixture-equivalence.test.ts`

- [ ] **Step 1: Write the real-fixture equivalence test**

Ingest the real committed `fixtures/software-dev-agentic-registry/registry-envelope.json` plus every referenced admission envelope under `fixtures/software-dev-agentic-registry/admissions/**` through `ingestClosure` against the local Supabase instance (gated on `SOFTWARE_DEV_AGENTIC_ROOT`-style opt-in env var being unnecessary here — this test only needs the committed fixture, no external repo). Assert exactly 152 persisted packages. Then call `resolveGenerationFromRegistry` with `examples/mobile-talenta/cipherpol.yaml`'s manifest and the same client capabilities used by `pnpm smoke:local`, and assert the returned `Generation.generationId` and package set exactly match calling `resolveGeneration` directly against `loadRegistry(fixtures/local-registry)`'s equivalent manifest — or, if the mobile-talenta manifest's capability packs are not present in the real Stage 2 corpus, construct a manifest from one capability pack that is actually present in the ingested real registry and assert internal resolution consistency (same generation ID on two independent resolutions from the persisted snapshot).

- [ ] **Step 2: Run full control-plane suite**

```bash
supabase db reset --local
SUPABASE_URL=$(supabase status -o json | jq -r '.API_URL') \
SUPABASE_SERVICE_ROLE_KEY=$(supabase status -o json | jq -r '.SERVICE_ROLE_KEY') \
  pnpm --filter @cipherpol/control-plane test
pnpm --filter @cipherpol/control-plane typecheck
supabase db advisors
```

Expected: all tests PASS; typecheck clean; advisors report no unresolved findings.

- [ ] **Step 3: Run full workspace verification**

```bash
pnpm verify
```

Expected: all four workspace packages typecheck and test clean; Stage 1/2 behavior unaffected (this slice adds a new package and does not modify `packages/contracts`, `packages/admission`, or `packages/resolver`).

- [ ] **Step 4: Dispatch final reviews**

Parallel read-only reviews: code correctness (ingestion verification completeness, resolver equivalence), security (RLS policies, service-role key handling, SQL injection surface via `supabase-js` query builder usage, error-detail redaction). Fix every Critical/High/Important finding and rerun affected verification.

- [ ] **Step 5: Commit**

```bash
git add packages/control-plane
git commit -m "test: prove Cipherpol control-plane registry equivalence"
```

---

## Completion evidence

The handoff must report:

- Supabase local stack status and `db advisors` result;
- control-plane test count and pass/fail;
- workspace `pnpm verify` result;
- real-fixture ingestion count (152 packages) and generation-resolution equivalence proof;
- final review verdicts;
- commit SHAs for this slice;
- explicit confirmation that Stage 1 (`loadRegistry`/`resolveGeneration`/`assembleRuntime`) and Stage 2 (`admission`/`contracts`) packages were not modified.
