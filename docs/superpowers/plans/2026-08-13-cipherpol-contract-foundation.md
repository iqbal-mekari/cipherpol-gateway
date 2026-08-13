# Cipherpol Contract Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build stable Cipherpol contracts and a local vertical slice that turns `cipherpol.yaml` plus an immutable filesystem registry into a verified `cipherpol-runtime`, `cipherpol.lock`, and parity manifest.

**Architecture:** Use two small TypeScript workspace packages: `@cipherpol/contracts` owns runtime-validated public objects; `@cipherpol/resolver` loads, resolves, verifies, and assembles generations. A thin Claude plugin delegates commands to the resolver. Stage 1 has no network, database, SSO, or production MCP proxy; those integrate later without changing these contracts.

**Tech Stack:** Node.js 20+, TypeScript 5, pnpm 10, Zod 4, YAML 2, semver 7, Node test runner through `tsx --test`, Claude Code plugin manifests.

---

## Stage boundary

This plan produces executable software:

```text
cipherpol.yaml + registry/index.yaml + package directories
  → validate → resolve → verify digests → assemble runtime → write cipherpol.lock
```

It also defines the parity-manifest schema required to account for all 34 user-facing entries, 67 shipped skills, 47 agents, 36 Markdown references, the taxonomy, and 17 cp1 MCP tools. Importing the full authored corpus and proving semantic parity is Stage 2.

## File map

```text
package.json                            workspace commands
pnpm-workspace.yaml                     package membership
tsconfig.base.json                      strict shared compiler settings
packages/contracts/src/schemas.ts       registry, manifest, lock, parity schemas
packages/contracts/src/models.ts        inferred public types
packages/contracts/src/canonical.ts     deterministic serialization
packages/resolver/src/load.ts           YAML manifest/registry loading
packages/resolver/src/resolve.ts        compatible deterministic generation
packages/resolver/src/digest.ts         immutable directory hashing
packages/resolver/src/assemble.ts       traversal-safe runtime assembly
packages/resolver/src/cli.ts            explicit local lifecycle CLI
plugins/cipherpol/                      thin Claude bootstrap adapter
fixtures/local-registry/                executable registry fixture
examples/mobile-talenta/                smoke consumer
```

### Task 1: Establish the strict workspace

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`

- [ ] **Step 1: Create the root package file**

```json
{
  "name": "cipherpol-gateway",
  "version": "0.1.0",
  "private": true,
  "packageManager": "pnpm@10.15.0",
  "engines": { "node": ">=20.19.0" },
  "scripts": {
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "verify": "pnpm typecheck && pnpm test"
  },
  "devDependencies": {
    "@types/node": "^24.3.0",
    "tsx": "^4.20.5",
    "typescript": "^5.9.2"
  }
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - packages/*
```

- [ ] **Step 3: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "skipLibCheck": true
  }
}
```

- [ ] **Step 4: Install and verify**

Run:

```bash
pnpm install
pnpm verify
```

Expected: dependency installation succeeds; recursive commands exit zero with no workspace packages yet.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json pnpm-lock.yaml
git commit -m "chore: establish Cipherpol workspace"
```

### Task 2: Define registry, consumer, and parity contracts

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/canonical.ts`
- Create: `packages/contracts/src/schemas.ts`
- Create: `packages/contracts/src/models.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/schemas.test.ts`

- [ ] **Step 1: Create `packages/contracts/package.json` and `tsconfig.json`**

```json
{
  "name": "@cipherpol/contracts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "tsx --test test/**/*.test.ts"
  },
  "dependencies": { "zod": "^4.1.5" },
  "devDependencies": {
    "@types/node": "^24.3.0",
    "tsx": "^4.20.5",
    "typescript": "^5.9.2"
  }
}
```

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 2: Write failing contract tests**

Create `packages/contracts/test/schemas.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  cipherpolManifestSchema,
  packageRecordSchema,
  parityManifestSchema,
} from "../src/index.js";

const validPackage = {
  id: "cipherpol.aegis/agent/task-router",
  kind: "agent",
  version: "1.0.0",
  digest: `sha256:${"a".repeat(64)}`,
  owner: "mobile-platform",
  sourceRevision: "0123456789abcdef",
  artifactPath: "artifacts/task-router",
  compatibility: { claudeCode: ">=2.1.0", capabilities: ["plugins"] },
  dependencies: [],
  files: [{ source: "task-router.md", target: "agents/task-router.md" }],
};

test("requires namespaced package IDs", () => {
  assert.equal(packageRecordSchema.parse(validPackage).id, validPackage.id);
  assert.throws(() => packageRecordSchema.parse({ ...validPackage, id: "task-router" }));
});

test("rejects traversal in mapped files", () => {
  assert.throws(() => packageRecordSchema.parse({
    ...validPackage,
    files: [{ source: "task-router.md", target: "../task-router.md" }],
  }));
});

test("requires exact pins for the pinned channel", () => {
  assert.throws(() => cipherpolManifestSchema.parse({
    schemaVersion: "cipherpol.mekari.com/v1",
    project: "mobile-talenta",
    platforms: ["flutter"],
    channel: "pinned",
    capabilityPacks: ["cipherpol.aegis/pack/general"],
    playbooks: [],
    policyProfile: "standard",
    owners: ["mobile-platform"],
  }));
});

test("parity entries cannot silently use generic fallback", () => {
  assert.throws(() => parityManifestSchema.parse({
    schemaVersion: "cipherpol.parity/v1",
    sourceMarketplaceRevision: "0123456789abcdef",
    baseline: { userFacing: 34, skills: 67, agents: 47, references: 36, cp1Tools: 17 },
    entries: [{
      id: "cipherpol.aegis/skill/developer-plan-feature",
      sourcePath: "cipherpol-aegis/lib/developer/skills/orchestrators/developer-plan-feature/SKILL.md",
      artifactType: "orchestrator",
      shipped: true,
      state: "generic-fallback",
      evidence: [],
    }],
  }));
});
```

- [ ] **Step 3: Verify tests fail**

Run:

```bash
pnpm --filter @cipherpol/contracts test
```

Expected: FAIL because `src/index.ts` does not exist.

- [ ] **Step 4: Implement deterministic serialization**

Create `packages/contracts/src/canonical.ts`:

```ts
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalize(child)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}
```

- [ ] **Step 5: Implement runtime schemas**

Create `packages/contracts/src/schemas.ts`:

```ts
import { z } from "zod";

const stableId = z.string().regex(/^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9._/-]*$/);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const relativePath = z.string().min(1).refine(
  (path) => !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes(".."),
  "path must be relative and traversal-free",
);
const reference = z.string().regex(/^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9._/-]*@[^\s]+$/);

export const packageRecordSchema = z.object({
  id: stableId,
  kind: z.enum(["agent", "skill", "procedure", "reference", "hook", "validator", "adapter", "bootstrap"]),
  version,
  digest,
  owner: z.string().min(1),
  sourceRevision: z.string().min(7),
  artifactPath: relativePath,
  compatibility: z.object({
    claudeCode: z.string().min(1),
    capabilities: z.array(z.string().min(1)).default([]),
  }),
  dependencies: z.array(reference).default([]),
  files: z.array(z.object({ source: relativePath, target: relativePath })).min(1),
  revoked: z.boolean().default(false),
});

export const capabilityPackSchema = z.object({
  id: stableId,
  version,
  intents: z.array(z.string().min(1)).min(1),
  platforms: z.array(z.enum(["flutter", "android", "ios", "web-nextjs", "generic"])).min(1),
  orchestrator: reference,
  packages: z.array(reference).min(1),
  playbooks: z.array(reference).default([]),
  toolBundle: stableId.optional(),
  requiredEvidence: z.array(z.string().min(1)).default([]),
  revoked: z.boolean().default(false),
});

export const playbookSchema = z.object({
  id: stableId,
  version,
  owner: z.string().min(1),
  platforms: z.array(z.enum(["flutter", "android", "ios", "web-nextjs", "generic"])).min(1),
  guidancePackages: z.array(reference).default([]),
  hookPackages: z.array(reference).default([]),
  validatorPackages: z.array(reference).default([]),
  rules: z.array(z.object({
    id: stableId,
    level: z.enum(["recommend", "verify", "require"]),
    rationale: z.string().min(1),
    remediation: z.string().min(1),
  })).min(1),
  revoked: z.boolean().default(false),
});

export const registryIndexSchema = z.object({
  schemaVersion: z.literal("cipherpol.registry/v1"),
  packages: z.array(packageRecordSchema),
  capabilityPacks: z.array(capabilityPackSchema),
  playbooks: z.array(playbookSchema),
});

export const cipherpolManifestSchema = z.object({
  schemaVersion: z.literal("cipherpol.mekari.com/v1"),
  project: z.string().min(1),
  platforms: z.array(z.enum(["flutter", "android", "ios", "web-nextjs"])).min(1),
  channel: z.enum(["canary", "stable", "pinned"]),
  capabilityPacks: z.array(stableId).min(1),
  playbooks: z.array(stableId).default([]),
  policyProfile: z.string().min(1),
  owners: z.array(z.string().min(1)).min(1),
  pins: z.record(stableId, version).optional(),
}).superRefine((manifest, context) => {
  if (manifest.channel === "pinned" && !manifest.pins) {
    context.addIssue({ code: "custom", path: ["pins"], message: "pinned channel requires pins" });
  }
});

export const generationSchema = z.object({
  schemaVersion: z.literal("cipherpol.generation/v1"),
  generationId: digest,
  project: z.string().min(1),
  channel: z.enum(["canary", "stable", "pinned"]),
  capabilityPacks: z.array(z.object({ id: stableId, version })),
  playbooks: z.array(z.object({ id: stableId, version })),
  packages: z.array(packageRecordSchema.pick({
    id: true, kind: true, version: true, digest: true, artifactPath: true, files: true,
  })),
  toolBundles: z.array(stableId),
  requiredEvidence: z.array(z.string()),
});

export const cipherpolLockSchema = z.object({
  schemaVersion: z.literal("cipherpol.lock/v1"),
  generationId: digest,
  project: z.string().min(1),
  channel: z.enum(["canary", "stable", "pinned"]),
  packages: z.array(z.object({ id: stableId, version, digest })),
  activatedAt: z.string().datetime(),
  previousHealthyGenerationId: digest.optional(),
  health: z.object({ status: z.literal("healthy"), checkedAt: z.string().datetime() }),
});

const parityState = z.enum(["equivalent", "normalized-dependency", "explicitly-unsupported"]);
export const parityManifestSchema = z.object({
  schemaVersion: z.literal("cipherpol.parity/v1"),
  sourceMarketplaceRevision: z.string().min(7),
  baseline: z.object({
    userFacing: z.literal(34),
    skills: z.literal(67),
    agents: z.literal(47),
    references: z.literal(36),
    cp1Tools: z.literal(17),
  }),
  entries: z.array(z.object({
    id: stableId,
    sourcePath: relativePath,
    artifactType: z.enum(["orchestrator", "procedure", "agent", "reference", "taxonomy", "mcp-tool", "setup-behavior"]),
    shipped: z.literal(true),
    state: parityState,
    trigger: z.string().min(1).optional(),
    composition: z.array(stableId).default([]),
    dependencies: z.array(stableId).default([]),
    platforms: z.array(z.string()).default([]),
    evidence: z.array(z.string().min(1)).min(1),
    decisionReference: z.string().min(1).optional(),
  }).superRefine((entry, context) => {
    if (entry.state === "explicitly-unsupported" && !entry.decisionReference) {
      context.addIssue({ code: "custom", path: ["decisionReference"], message: "unsupported entries require approval" });
    }
  })).min(1),
});
```

- [ ] **Step 6: Export inferred types**

Create `packages/contracts/src/models.ts`:

```ts
import type { z } from "zod";
import type {
  capabilityPackSchema, cipherpolLockSchema, cipherpolManifestSchema,
  generationSchema, packageRecordSchema, parityManifestSchema,
  playbookSchema, registryIndexSchema,
} from "./schemas.js";

export type PackageRecord = z.infer<typeof packageRecordSchema>;
export type CapabilityPack = z.infer<typeof capabilityPackSchema>;
export type Playbook = z.infer<typeof playbookSchema>;
export type RegistryIndex = z.infer<typeof registryIndexSchema>;
export type CipherpolManifest = z.infer<typeof cipherpolManifestSchema>;
export type Generation = z.infer<typeof generationSchema>;
export type CipherpolLock = z.infer<typeof cipherpolLockSchema>;
export type ParityManifest = z.infer<typeof parityManifestSchema>;
```

Create `packages/contracts/src/index.ts`:

```ts
export { canonicalJson } from "./canonical.js";
export * from "./schemas.js";
export type * from "./models.js";
```

- [ ] **Step 7: Verify and commit**

Run:

```bash
pnpm install
pnpm --filter @cipherpol/contracts test
pnpm --filter @cipherpol/contracts typecheck
```

Expected: four tests PASS; typecheck exits zero.

```bash
git add packages/contracts pnpm-lock.yaml
git commit -m "feat: define Cipherpol public contracts"
```

### Task 3: Load manifests and registries with stable errors

**Files:**
- Create: `packages/resolver/package.json`
- Create: `packages/resolver/tsconfig.json`
- Create: `packages/resolver/src/errors.ts`
- Create: `packages/resolver/src/load.ts`
- Create: `packages/resolver/src/index.ts`
- Create: `packages/resolver/test/load.test.ts`

- [ ] **Step 1: Create resolver package metadata**

`packages/resolver/package.json`:

```json
{
  "name": "@cipherpol/resolver",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "tsx --test test/**/*.test.ts"
  },
  "dependencies": {
    "@cipherpol/contracts": "workspace:*",
    "semver": "^7.7.2",
    "yaml": "^2.8.1"
  },
  "devDependencies": {
    "@types/node": "^24.3.0",
    "@types/semver": "^7.7.0",
    "tsx": "^4.20.5",
    "typescript": "^5.9.2"
  }
}
```

`packages/resolver/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

- [ ] **Step 2: Write failing loader tests**

`packages/resolver/test/load.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CipherpolError, loadManifest } from "../src/index.js";

async function manifest(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cipherpol-load-"));
  const path = join(directory, "cipherpol.yaml");
  await writeFile(path, content);
  return path;
}

test("loads a valid manifest", async () => {
  const path = await manifest(`schemaVersion: cipherpol.mekari.com/v1
project: mobile-talenta
platforms: [flutter]
channel: stable
capabilityPacks: [cipherpol.aegis/pack/general]
playbooks: []
policyProfile: standard
owners: [mobile-platform]
`);
  assert.equal((await loadManifest(path)).project, "mobile-talenta");
});

test("uses a stable error for invalid input", async () => {
  await assert.rejects(loadManifest(await manifest("project: mobile-talenta\n")),
    (error: unknown) => error instanceof CipherpolError && error.code === "INVALID_MANIFEST");
});
```

- [ ] **Step 3: Verify failure**

```bash
pnpm --filter @cipherpol/resolver test
```

Expected: FAIL because source exports do not exist.

- [ ] **Step 4: Implement errors and loaders**

`packages/resolver/src/errors.ts`:

```ts
export type ErrorCode = "INVALID_MANIFEST" | "INVALID_REGISTRY" | "UNRESOLVABLE_GENERATION" |
  "ARTIFACT_MISMATCH" | "TARGET_COLLISION" | "UNSAFE_PATH";
export class CipherpolError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message); this.name = "CipherpolError";
  }
}
```

`packages/resolver/src/load.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cipherpolManifestSchema, registryIndexSchema,
  type CipherpolManifest, type RegistryIndex,
} from "@cipherpol/contracts";
import { parse } from "yaml";
import { CipherpolError } from "./errors.js";

async function document(path: string, code: "INVALID_MANIFEST" | "INVALID_REGISTRY"): Promise<unknown> {
  try { return parse(await readFile(path, "utf8")); }
  catch (cause) {
    throw new CipherpolError(code, `Cannot load ${path}`, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
export async function loadManifest(path: string): Promise<CipherpolManifest> {
  try { return cipherpolManifestSchema.parse(await document(path, "INVALID_MANIFEST")); }
  catch (cause) {
    if (cause instanceof CipherpolError) throw cause;
    throw new CipherpolError("INVALID_MANIFEST", `Invalid manifest ${path}`, { cause: String(cause) });
  }
}
export async function loadRegistry(root: string): Promise<{ root: string; index: RegistryIndex }> {
  const path = join(root, "index.yaml");
  try { return { root, index: registryIndexSchema.parse(await document(path, "INVALID_REGISTRY")) }; }
  catch (cause) {
    if (cause instanceof CipherpolError) throw cause;
    throw new CipherpolError("INVALID_REGISTRY", `Invalid registry ${path}`, { cause: String(cause) });
  }
}
```

`packages/resolver/src/index.ts`:

```ts
export * from "./errors.js";
export * from "./load.js";
```

- [ ] **Step 5: Verify and commit**

```bash
pnpm install
pnpm --filter @cipherpol/resolver test
pnpm --filter @cipherpol/resolver typecheck
git add packages/resolver pnpm-lock.yaml
git commit -m "feat: load Cipherpol desired and registry state"
```

Expected: two tests PASS; typecheck exits zero.

### Task 4: Resolve deterministic compatible generations

**Files:**
- Create: `packages/resolver/src/resolve.ts`
- Modify: `packages/resolver/src/index.ts`
- Create: `packages/resolver/test/resolve.test.ts`

- [ ] **Step 1: Write failing resolver tests**

Create `packages/resolver/test/resolve.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { CipherpolManifest, PackageRecord, RegistryIndex } from "@cipherpol/contracts";
import { CipherpolError, resolveGeneration } from "../src/index.js";

const manifest: CipherpolManifest = {
  schemaVersion: "cipherpol.mekari.com/v1",
  project: "mobile-talenta",
  platforms: ["flutter"],
  channel: "stable",
  capabilityPacks: ["cipherpol.aegis/pack/general"],
  playbooks: [],
  policyProfile: "standard",
  owners: ["mobile-platform"],
};
const client = { claudeCodeVersion: "2.1.89", capabilities: new Set(["plugins"]) };

function packageRecord(version: string, revoked = false): PackageRecord {
  return {
    id: "cipherpol.aegis/agent/task-router",
    kind: "agent",
    version,
    digest: `sha256:${"a".repeat(64)}`,
    owner: "mobile-platform",
    sourceRevision: "0123456789abcdef",
    artifactPath: `artifacts/task-router-${version}`,
    compatibility: { claudeCode: ">=2.1.0 <3.0.0", capabilities: ["plugins"] },
    dependencies: [],
    files: [{ source: "task-router.md", target: "agents/task-router.md" }],
    revoked,
  };
}

function registryWith(...versions: string[]): RegistryIndex {
  return {
    schemaVersion: "cipherpol.registry/v1",
    packages: versions.map((version) => packageRecord(version)),
    capabilityPacks: [{
      id: "cipherpol.aegis/pack/general",
      version: "1.0.0",
      intents: ["mobile-development"],
      platforms: ["flutter", "android", "ios", "web-nextjs", "generic"],
      orchestrator: "cipherpol.aegis/agent/task-router@^1.0.0",
      packages: ["cipherpol.aegis/agent/task-router@^1.0.0"],
      playbooks: [],
      requiredEvidence: ["focused-validation"],
      revoked: false,
    }],
    playbooks: [],
  };
}

test("selects the highest compatible package", () => {
  assert.equal(resolveGeneration(manifest, registryWith("1.0.0", "1.2.0"), client).packages[0]?.version, "1.2.0");
});

test("resolution is independent of registry order", () => {
  assert.deepEqual(
    resolveGeneration(manifest, registryWith("1.0.0", "1.2.0"), client),
    resolveGeneration(manifest, registryWith("1.2.0", "1.0.0"), client),
  );
});

test("revoked packages cannot resolve", () => {
  const registry = registryWith("1.2.0");
  registry.packages = [packageRecord("1.2.0", true)];
  assert.throws(
    () => resolveGeneration(manifest, registry, client),
    (error: unknown) => error instanceof CipherpolError && error.code === "UNRESOLVABLE_GENERATION",
  );
});

test("required client capabilities are enforced", () => {
  assert.throws(
    () => resolveGeneration(manifest, registryWith("1.2.0"), {
      claudeCodeVersion: "2.1.89",
      capabilities: new Set(),
    }),
    (error: unknown) => error instanceof CipherpolError && error.code === "UNRESOLVABLE_GENERATION",
  );
});
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @cipherpol/resolver test
```

Expected: FAIL because `resolveGeneration` is absent.

- [ ] **Step 3: Implement `packages/resolver/src/resolve.ts`**

```ts
import { createHash } from "node:crypto";
import {
  canonicalJson, generationSchema,
  type CipherpolManifest, type Generation, type PackageRecord, type RegistryIndex,
} from "@cipherpol/contracts";
import { maxSatisfying, satisfies } from "semver";
import { CipherpolError } from "./errors.js";

export interface Client { claudeCodeVersion: string; capabilities: ReadonlySet<string> }
const ref = (value: string) => ({ id: value.slice(0, value.lastIndexOf("@")), range: value.slice(value.lastIndexOf("@") + 1) });

function latest<T extends { id: string; version: string; revoked: boolean }>(items: T[], id: string, manifest: CipherpolManifest): T {
  const candidates = items.filter((item) => item.id === id && !item.revoked);
  const range = manifest.pins?.[id] ?? (manifest.channel === "canary" ? ">=0.0.0-0" : "*");
  const selectedVersion = maxSatisfying(candidates.map(({ version }) => version), range, {
    includePrerelease: manifest.channel === "canary",
  });
  const selected = candidates.find(({ version }) => version === selectedVersion);
  if (!selected) throw new CipherpolError("UNRESOLVABLE_GENERATION", `No eligible ${id}`);
  return selected;
}

function selectPackage(reference: string, manifest: CipherpolManifest, registry: RegistryIndex, client: Client): PackageRecord {
  const parsed = ref(reference);
  const range = manifest.pins?.[parsed.id] ?? parsed.range;
  const candidates = registry.packages.filter((item) => item.id === parsed.id && !item.revoked &&
    satisfies(item.version, range, { includePrerelease: manifest.channel === "canary" }) &&
    satisfies(client.claudeCodeVersion, item.compatibility.claudeCode) &&
    item.compatibility.capabilities.every((capability) => client.capabilities.has(capability)));
  const selectedVersion = maxSatisfying(candidates.map(({ version }) => version), range, {
    includePrerelease: manifest.channel === "canary",
  });
  const selected = candidates.find(({ version }) => version === selectedVersion);
  if (!selected) throw new CipherpolError("UNRESOLVABLE_GENERATION", `No compatible package ${reference}`);
  return selected;
}

export function resolveGeneration(manifest: CipherpolManifest, registry: RegistryIndex, client: Client): Generation {
  const packs = manifest.capabilityPacks.map((id) => latest(registry.capabilityPacks, id, manifest));
  for (const pack of packs) if (!pack.platforms.some((platform) => manifest.platforms.includes(platform as never) || platform === "generic")) {
    throw new CipherpolError("UNRESOLVABLE_GENERATION", `${pack.id} does not support this project`);
  }
  const playbookIds = new Set([...manifest.playbooks, ...packs.flatMap((pack) => pack.playbooks.map((item) => ref(item).id))]);
  const playbooks = [...playbookIds].map((id) => latest(registry.playbooks, id, manifest));
  const selected = new Map<string, PackageRecord>();
  const visit = (reference: string): void => {
    const candidate = selectPackage(reference, manifest, registry, client);
    const current = selected.get(candidate.id);
    if (current && current.version !== candidate.version) throw new CipherpolError("UNRESOLVABLE_GENERATION", `Version conflict ${candidate.id}`);
    if (!current) { selected.set(candidate.id, candidate); candidate.dependencies.forEach(visit); }
  };
  packs.flatMap((pack) => [pack.orchestrator, ...pack.packages]).forEach(visit);
  playbooks.flatMap((book) => [...book.guidancePackages, ...book.hookPackages, ...book.validatorPackages]).forEach(visit);
  const body = {
    schemaVersion: "cipherpol.generation/v1" as const,
    project: manifest.project,
    channel: manifest.channel,
    capabilityPacks: packs.map(({ id, version }) => ({ id, version })).sort((a, b) => a.id.localeCompare(b.id)),
    playbooks: playbooks.map(({ id, version }) => ({ id, version })).sort((a, b) => a.id.localeCompare(b.id)),
    packages: [...selected.values()].sort((a, b) => a.id.localeCompare(b.id)).map(
      ({ id, kind, version, digest, artifactPath, files }) => ({ id, kind, version, digest, artifactPath, files }),
    ),
    toolBundles: [...new Set(packs.flatMap((pack) => pack.toolBundle ? [pack.toolBundle] : []))].sort(),
    requiredEvidence: [...new Set(packs.flatMap((pack) => pack.requiredEvidence))].sort(),
  };
  return generationSchema.parse({
    ...body,
    generationId: `sha256:${createHash("sha256").update(canonicalJson(body)).digest("hex")}`,
  });
}
```

Append:

```ts
export * from "./resolve.js";
```

to `packages/resolver/src/index.ts`.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @cipherpol/resolver test
pnpm --filter @cipherpol/resolver typecheck
git add packages/resolver
git commit -m "feat: resolve deterministic Cipherpol generations"
```

Expected: order independence, highest compatible selection, revocation, and capability tests PASS.

### Task 5: Verify artifacts and assemble runtime generations

**Files:**
- Create: `packages/resolver/src/digest.ts`
- Create: `packages/resolver/src/assemble.ts`
- Modify: `packages/resolver/src/index.ts`
- Create: `packages/resolver/test/assemble.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/resolver/test/assemble.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Generation } from "@cipherpol/contracts";
import { assembleRuntime, CipherpolError, digestDirectory } from "../src/index.js";

async function fixture(): Promise<{ registry: string; output: string; digest: string }> {
  const root = await mkdtemp(join(tmpdir(), "cipherpol-assemble-"));
  const registry = join(root, "registry");
  const artifact = join(registry, "artifacts/task-router");
  await mkdir(artifact, { recursive: true });
  await writeFile(join(artifact, "task-router.md"), "# Task Router\n");
  return { registry, output: join(root, "runtime"), digest: await digestDirectory(artifact) };
}
function generation(digest: string): Generation {
  return {
    schemaVersion: "cipherpol.generation/v1",
    generationId: `sha256:${"b".repeat(64)}`,
    project: "mobile-talenta",
    channel: "stable",
    capabilityPacks: [{ id: "cipherpol.aegis/pack/general", version: "1.0.0" }],
    playbooks: [],
    packages: [{
      id: "cipherpol.aegis/agent/task-router",
      kind: "agent",
      version: "1.0.0",
      digest,
      artifactPath: "artifacts/task-router",
      files: [{ source: "task-router.md", target: "agents/task-router.md" }],
    }],
    toolBundles: [],
    requiredEvidence: [],
  };
}
test("assembles verified content and generation metadata", async () => {
  const data = await fixture();
  await assembleRuntime(generation(data.digest), data.registry, data.output);
  assert.equal(await readFile(join(data.output, "agents/task-router.md"), "utf8"), "# Task Router\n");
  assert.match(await readFile(join(data.output, "cipherpol-generation.json"), "utf8"), /mobile-talenta/);
});
test("rejects artifact tampering before replacing runtime", async () => {
  const data = await fixture();
  await assert.rejects(
    assembleRuntime(generation(`sha256:${"c".repeat(64)}`), data.registry, data.output),
    (error: unknown) => error instanceof CipherpolError && error.code === "ARTIFACT_MISMATCH",
  );
});
test("rejects target collisions", async () => {
  const data = await fixture();
  const duplicate = generation(data.digest);
  duplicate.packages.push({ ...duplicate.packages[0]!, id: "cipherpol.aegis/agent/duplicate" });
  await assert.rejects(
    assembleRuntime(duplicate, data.registry, data.output),
    (error: unknown) => error instanceof CipherpolError && error.code === "TARGET_COLLISION",
  );
});
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @cipherpol/resolver test
```

Expected: FAIL because digest and assembly functions are absent.

- [ ] **Step 3: Implement deterministic directory hashing**

`packages/resolver/src/digest.ts`:

```ts
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
async function files(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory()
    ? files(root, join(dir, entry.name)) : [join(dir, entry.name)])))
    .flat().sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
}
export async function digestDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await files(root)) {
    hash.update(relative(root, file).replaceAll("\\", "/")); hash.update("\0");
    hash.update(await readFile(file)); hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
```

- [ ] **Step 4: Implement safe staged assembly**

`packages/resolver/src/assemble.ts`:

```ts
import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Generation } from "@cipherpol/contracts";
import { digestDirectory } from "./digest.js";
import { CipherpolError } from "./errors.js";
function inside(root: string, child: string): string {
  const base = resolve(root); const target = resolve(root, child);
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new CipherpolError("UNSAFE_PATH", `Path escapes root: ${child}`);
  return target;
}
export async function assembleRuntime(generation: Generation, registryRoot: string, output: string): Promise<void> {
  const stage = `${output}.stage-${process.pid}`; const backup = `${output}.backup-${process.pid}`;
  const targets = new Set<string>(); let movedCurrent = false;
  await rm(stage, { recursive: true, force: true }); await rm(backup, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  try {
    for (const pkg of generation.packages) {
      const artifact = inside(registryRoot, pkg.artifactPath);
      const actual = await digestDirectory(artifact);
      if (actual !== pkg.digest) throw new CipherpolError("ARTIFACT_MISMATCH", `Digest mismatch ${pkg.id}`, { expected: pkg.digest, actual });
      for (const file of pkg.files) {
        const target = inside(stage, file.target);
        if (targets.has(target)) throw new CipherpolError("TARGET_COLLISION", `Collision ${file.target}`);
        targets.add(target); await mkdir(dirname(target), { recursive: true });
        await cp(inside(artifact, file.source), target, { errorOnExist: true });
      }
    }
    await writeFile(join(stage, "cipherpol-generation.json"), `${JSON.stringify(generation, null, 2)}\n`, { flag: "wx" });
    try { await rename(output, backup); movedCurrent = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await rename(stage, output); }
    catch (error) {
      if (movedCurrent) await rename(backup, output);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(stage, { recursive: true, force: true });
    if (!movedCurrent) await rm(backup, { recursive: true, force: true });
  }
}
```

Export both modules from `src/index.ts`.

- [ ] **Step 5: Verify and commit**

```bash
pnpm --filter @cipherpol/resolver test
pnpm --filter @cipherpol/resolver typecheck
git add packages/resolver
git commit -m "feat: assemble verified Cipherpol runtimes"
```

Expected: success, tamper, collision, and traversal contracts PASS.

### Task 6: Add explicit setup and update-check commands

**Files:**
- Create: `packages/resolver/src/cli.ts`
- Create: `packages/resolver/test/cli.e2e.test.ts`

- [ ] **Step 1: Write an end-to-end failing test**

Create `packages/resolver/test/cli.e2e.test.ts`:

```ts
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { digestDirectory } from "../src/index.js";

const execute = promisify(execFile);
const resolverRoot = resolve(".");
const cli = resolve("src/cli.ts");
async function environment(): Promise<{ cwd: string; registry: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "cipherpol-cli-"));
  const registry = join(cwd, "registry");
  const artifact = join(registry, "artifacts/task-router");
  await mkdir(artifact, { recursive: true });
  await writeFile(join(artifact, "task-router.md"), "# Router\n");
  const digest = await digestDirectory(artifact);
  await writeFile(join(cwd, "cipherpol.yaml"), `schemaVersion: cipherpol.mekari.com/v1
project: mobile-talenta
platforms: [flutter]
channel: stable
capabilityPacks: [cipherpol.aegis/pack/general]
playbooks: []
policyProfile: standard
owners: [mobile-platform]
`);
  await writeFile(join(registry, "index.yaml"), `schemaVersion: cipherpol.registry/v1
packages:
  - id: cipherpol.aegis/agent/task-router
    kind: agent
    version: 1.0.0
    digest: ${digest}
    owner: mobile-platform
    sourceRevision: 0123456789abcdef
    artifactPath: artifacts/task-router
    compatibility:
      claudeCode: \">=2.1.0 <3.0.0\"
      capabilities: [plugins]
    dependencies: []
    files:
      - source: task-router.md
        target: agents/task-router.md
capabilityPacks:
  - id: cipherpol.aegis/pack/general
    version: 1.0.0
    intents: [engineering]
    platforms: [flutter, android, ios, web-nextjs, generic]
    orchestrator: cipherpol.aegis/agent/task-router@^1.0.0
    packages: [cipherpol.aegis/agent/task-router@^1.0.0]
    playbooks: []
    requiredEvidence: [focused-validation]
playbooks: []
`);
  return { cwd, registry };
}
function invocation(cwd: string, registry: string, ...operation: string[]) {
  return execute("pnpm", [
    "--dir", resolverRoot, "tsx", cli, ...operation,
    "--registry", registry, "--claude-version", "2.1.89", "--capability", "plugins",
  ], { cwd });
}
test("update check is read-only and confirmed setup writes a healthy lock", async () => {
  const data = await environment();
  assert.match((await invocation(data.cwd, data.registry, "update", "--check")).stdout, /available generation sha256:/);
  await assert.rejects(access(join(data.cwd, "cipherpol.lock")));
  assert.match((await invocation(data.cwd, data.registry, "setup", "--yes")).stdout, /activated generation sha256:/);
  const lock = JSON.parse(await readFile(join(data.cwd, "cipherpol.lock"), "utf8")) as { health: { status: string } };
  assert.equal(lock.health.status, "healthy");
});
test("unconfirmed setup exits two without mutation", async () => {
  const data = await environment();
  await assert.rejects(invocation(data.cwd, data.registry, "setup"), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === 2);
  await assert.rejects(access(join(data.cwd, "cipherpol.lock")));
  await assert.rejects(access(join(data.cwd, ".cipherpol/runtime")));
});
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @cipherpol/resolver test
```

Expected: FAIL because `src/cli.ts` is absent.

- [ ] **Step 3: Implement `packages/resolver/src/cli.ts`**

```ts
#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cipherpolLockSchema, type CipherpolLock } from "@cipherpol/contracts";
import { assembleRuntime, CipherpolError, loadManifest, loadRegistry, resolveGeneration } from "./index.js";
const values = (flag: string, args: string[]) => args.flatMap((value, index) => args[index - 1] === flag ? [value] : []);
const value = (flag: string, args: string[]) => values(flag, args).at(-1);
async function lock(path: string): Promise<CipherpolLock | undefined> {
  try { return cipherpolLockSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function main(args: string[]): Promise<void> {
  const [command, ...options] = args;
  if (command !== "setup" && command !== "update") throw new Error("Usage: cipherpol-local <setup|update>");
  const cwd = process.cwd(); const manifest = await loadManifest(resolve(cwd, "cipherpol.yaml"));
  const registry = await loadRegistry(resolve(value("--registry", options) ?? "fixtures/local-registry"));
  const claudeCodeVersion = value("--claude-version", options);
  if (!claudeCodeVersion) throw new Error("--claude-version is required");
  const generation = resolveGeneration(manifest, registry.index, {
    claudeCodeVersion, capabilities: new Set(values("--capability", options)),
  });
  const lockPath = resolve(cwd, "cipherpol.lock"); const previous = await lock(lockPath);
  if (options.includes("--check")) {
    console.log(`available generation ${generation.generationId}`);
    console.log(`active generation ${previous?.generationId ?? "none"}`); return;
  }
  if (!options.includes("--yes")) throw new CipherpolError("UNRESOLVABLE_GENERATION", "Explicit activation requires confirmation");
  await assembleRuntime(generation, registry.root, resolve(cwd, ".cipherpol/runtime"));
  const now = new Date().toISOString();
  await writeFile(lockPath, `${JSON.stringify(cipherpolLockSchema.parse({
    schemaVersion: "cipherpol.lock/v1", generationId: generation.generationId,
    project: generation.project, channel: generation.channel,
    packages: generation.packages.map(({ id, version, digest }) => ({ id, version, digest })),
    activatedAt: now, previousHealthyGenerationId: previous?.generationId,
    health: { status: "healthy", checkedAt: now },
  }), null, 2)}\n`);
  console.log(`activated generation ${generation.generationId}`);
  console.log("run /reload-plugins to load the selected runtime");
}
main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof CipherpolError) { console.error(`${error.code}: ${error.message}`); process.exitCode = 2; }
  else { console.error(error); process.exitCode = 1; }
});
```

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @cipherpol/resolver test
pnpm --filter @cipherpol/resolver typecheck
git add packages/resolver
git commit -m "feat: add explicit Cipherpol activation CLI"
```

Expected: update-check is read-only; unconfirmed setup fails without mutation; confirmed setup writes a healthy lock and runtime.

### Task 7: Package the thin Claude plugin

**Files:**
- Create: `plugins/cipherpol/.claude-plugin/plugin.json`
- Create: `plugins/cipherpol/commands/cipherpol-setup.md`
- Create: `plugins/cipherpol/commands/cipherpol-update.md`
- Create: `plugins/cipherpol/commands/cipherpol-doctor.md`
- Create: `plugins/cipherpol/commands/cipherpol-rollback.md`
- Create: `plugins/cipherpol/scripts/cipherpol-local`
- Create: `packages/resolver/test/plugin.test.ts`

- [ ] **Step 1: Write failing plugin tests**

Create `packages/resolver/test/plugin.test.ts`:

```ts
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const plugin = resolve("../../plugins/cipherpol");
for (const operation of ["setup", "update"]) {
  test(`ships cipherpol-${operation}`, async () => {
    const body = await readFile(resolve(plugin, `commands/cipherpol-${operation}.md`), "utf8");
    assert.match(body, new RegExp(`cipherpol-local ${operation}`));
  });
}
test("doctor delegates to read-only update check", async () => {
  assert.match(await readFile(resolve(plugin, "commands/cipherpol-doctor.md"), "utf8"), /cipherpol-local update --check/);
});
test("rollback is honest about the Stage 1 boundary", async () => {
  const body = await readFile(resolve(plugin, "commands/cipherpol-rollback.md"), "utf8");
  assert.match(body, /Rollback is introduced in Stage 4/);
  assert.doesNotMatch(body, /cipherpol-local rollback/);
});
test("bootstrap excludes runtime agents and skills", async () => {
  await assert.rejects(access(resolve(plugin, "agents")));
  await assert.rejects(access(resolve(plugin, "skills")));
});
```

- [ ] **Step 2: Verify failure**

```bash
pnpm --filter @cipherpol/resolver test
```

Expected: FAIL because the plugin does not exist.

- [ ] **Step 3: Create the plugin manifest and launcher**

`plugins/cipherpol/.claude-plugin/plugin.json`:

```json
{
  "name": "cipherpol",
  "version": "0.1.0",
  "description": "Cipherpol bootstrap for governed Mekari engineering AI tooling",
  "author": { "name": "Mekari Mobile Platform" }
}
```

`plugins/cipherpol/scripts/cipherpol-local`:

```bash
#!/usr/bin/env bash
set -euo pipefail
root="${CIPHERPOL_GATEWAY_ROOT:?CIPHERPOL_GATEWAY_ROOT is required for the Stage 1 local adapter}"
exec pnpm --dir "$root/packages/resolver" tsx src/cli.ts "$@"
```

- [ ] **Step 4: Create setup and update command adapters**

Create `plugins/cipherpol/commands/cipherpol-setup.md`:

```markdown
---
description: Resolve and explicitly activate Cipherpol tooling for this repository
allowed-tools: Bash
---

Run `${CLAUDE_PLUGIN_ROOT}/scripts/cipherpol-local setup "$@"`. Show the exact result. If activation succeeds, instruct the consumer to run `/reload-plugins`. Never claim the runtime is loaded before reload.
```

Create `plugins/cipherpol/commands/cipherpol-update.md`:

```markdown
---
description: Check or explicitly activate a compatible Cipherpol runtime
allowed-tools: Bash
---

Run `${CLAUDE_PLUGIN_ROOT}/scripts/cipherpol-local update "$@"`. Preserve `--check` as read-only. Never add `--yes`; only the consumer may provide explicit non-interactive confirmation. After activation, instruct the consumer to run `/reload-plugins`.
```

- [ ] **Step 5: Make doctor and rollback honest Stage 1 commands**

Create `plugins/cipherpol/commands/cipherpol-doctor.md`:

```markdown
---
description: Check local Cipherpol resolution without changing state
allowed-tools: Bash
---

Run `${CLAUDE_PLUGIN_ROOT}/scripts/cipherpol-local update --check "$@"`. Report the active and available generation exactly. State that full auth, MCP, hook, and post-reload diagnosis is introduced in Stage 4. Do not modify files.
```

Create `plugins/cipherpol/commands/cipherpol-rollback.md`:

```markdown
---
description: Explain the Stage 1 rollback boundary without changing state
allowed-tools: Bash
---

Do not run an activation command. Report: `Stage 1 records the previous generation ID but does not retain generation directories. Rollback is introduced in Stage 4; no files were changed.`
```

- [ ] **Step 6: Verify and commit**

```bash
chmod +x plugins/cipherpol/scripts/cipherpol-local
pnpm --filter @cipherpol/resolver test
pnpm verify
git add plugins packages/resolver
git commit -m "feat: add thin Cipherpol Claude plugin"
```

Expected: plugin tests PASS; the bootstrap contains commands/scripts only.

### Task 8: Prove the local vertical slice and parity contract

**Files:**
- Create: `fixtures/local-registry/write-index.ts`
- Create: `fixtures/local-registry/index.yaml`
- Create: `fixtures/local-registry/artifacts/task-router/task-router.md`
- Create: `fixtures/local-registry/artifacts/general-skill/SKILL.md`
- Create: `fixtures/parity/minimal-parity.yaml`
- Create: `examples/mobile-talenta/cipherpol.yaml`
- Create: `packages/resolver/test/parity-fixture.test.ts`
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `README.md`

- [ ] **Step 1: Add one real agent and skill fixture**

Create `fixtures/local-registry/artifacts/task-router/task-router.md`:

```markdown
---
name: cipherpol-task-router
description: Route engineering work to a registered Cipherpol capability pack.
tools: []
---

Classify only against registered capability packs. When no specialist matches, select `cipherpol.aegis/pack/general`. Never invent a specialist.
```

Create `fixtures/local-registry/artifacts/general-skill/SKILL.md`:

```markdown
---
name: cipherpol-general-engineering
description: Apply the general Mekari engineering workflow.
---

Identify the platform and repository rules, make the smallest correct change, run focused validation, and report evidence. Never claim CI or gateway enforcement for local guidance.
```

- [ ] **Step 2: Generate a registry index from measured digests**

Create `fixtures/local-registry/write-index.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { digestDirectory } from "../../packages/resolver/src/index.js";

const root = dirname(fileURLToPath(import.meta.url));
const router = await digestDirectory(join(root, "artifacts/task-router"));
const skill = await digestDirectory(join(root, "artifacts/general-skill"));
const index = `schemaVersion: cipherpol.registry/v1
packages:
  - id: cipherpol.aegis/agent/task-router
    kind: agent
    version: 1.0.0
    digest: ${router}
    owner: mobile-platform
    sourceRevision: 4685ccb
    artifactPath: artifacts/task-router
    compatibility:
      claudeCode: \">=2.1.0 <3.0.0\"
      capabilities: [plugins]
    dependencies: []
    files:
      - source: task-router.md
        target: agents/task-router.md
  - id: cipherpol.aegis/skill/general-engineering
    kind: skill
    version: 1.0.0
    digest: ${skill}
    owner: mobile-platform
    sourceRevision: 4685ccb
    artifactPath: artifacts/general-skill
    compatibility:
      claudeCode: \">=2.1.0 <3.0.0\"
      capabilities: [plugins]
    dependencies: []
    files:
      - source: SKILL.md
        target: skills/cipherpol-general-engineering/SKILL.md
capabilityPacks:
  - id: cipherpol.aegis/pack/general
    version: 1.0.0
    intents: [engineering]
    platforms: [flutter, android, ios, web-nextjs, generic]
    orchestrator: cipherpol.aegis/agent/task-router@^1.0.0
    packages:
      - cipherpol.aegis/agent/task-router@^1.0.0
      - cipherpol.aegis/skill/general-engineering@^1.0.0
    playbooks: []
    requiredEvidence: [focused-validation]
playbooks: []
`;
await writeFile(join(root, "index.yaml"), index);
console.log(router);
console.log(skill);
```

Run:

```bash
pnpm --filter @cipherpol/resolver tsx ../../fixtures/local-registry/write-index.ts
```

Expected: two measured `sha256:` values and a generated `fixtures/local-registry/index.yaml` containing those exact values.

- [ ] **Step 3: Create the consumer manifest**

Create `examples/mobile-talenta/cipherpol.yaml`:

```yaml
schemaVersion: cipherpol.mekari.com/v1
project: mobile-talenta
platforms: [flutter]
channel: stable
capabilityPacks:
  - cipherpol.aegis/pack/general
playbooks: []
policyProfile: standard
owners:
  - mobile-platform
```

- [ ] **Step 4: Create and validate a minimal parity fixture**

Create `fixtures/parity/minimal-parity.yaml`:

```yaml
schemaVersion: cipherpol.parity/v1
sourceMarketplaceRevision: 0123456789abcdef
baseline:
  userFacing: 34
  skills: 67
  agents: 47
  references: 36
  cp1Tools: 17
entries:
  - id: cipherpol.aegis/agent/task-router
    sourcePath: fixtures/local-registry/artifacts/task-router/task-router.md
    artifactType: agent
    shipped: true
    state: equivalent
    composition: []
    dependencies: []
    platforms: [flutter, android, ios, web-nextjs]
    evidence:
      - invocation fixture resolves the registered general capability pack
      - packaging fixture assembles agents/task-router.md
```

Create `packages/resolver/test/parity-fixture.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parityManifestSchema } from "@cipherpol/contracts";
import { parse } from "yaml";

test("fixture preserves the complete software-dev-agentic baseline counts", async () => {
  const fixture = parse(await readFile(resolve("../../fixtures/parity/minimal-parity.yaml"), "utf8"));
  const parity = parityManifestSchema.parse(fixture);
  assert.deepEqual(parity.baseline, {
    userFacing: 34,
    skills: 67,
    agents: 47,
    references: 36,
    cp1Tools: 17,
  });
});
```

- [ ] **Step 5: Add smoke, ignore, and usage contracts**

Add this script to root `package.json`:

```json
\"smoke:local\": \"rm -rf examples/mobile-talenta/.cipherpol examples/mobile-talenta/cipherpol.lock && cd examples/mobile-talenta && pnpm --dir ../../packages/resolver tsx src/cli.ts setup --yes --registry ../../fixtures/local-registry --claude-version 2.1.89 --capability plugins\"
```

Append to `.gitignore`:

```gitignore
examples/**/.cipherpol/
examples/**/cipherpol.lock
```

Create `README.md`:

````markdown
# Cipherpol Gateway

Cipherpol distributes versioned engineering agents, skills, playbooks, and governed MCP access. The approved architecture is in `docs/superpowers/specs/2026-08-13-cipherpol-gateway-design.md`.

## Stage 1 verification

```bash
pnpm install
pnpm verify
pnpm smoke:local
```

Stage 1 uses a local filesystem registry. It performs no SSO, network, database, signature, or MCP operation. `update --check` is read-only; activation requires explicit `setup --yes`.
````

- [ ] **Step 6: Run final verification**

```bash
pnpm verify
pnpm smoke:local
```

Expected: all tests/typechecks PASS; output includes `activated generation sha256:` and `/reload-plugins`; generated agent, skill, generation metadata, and healthy lock exist.

- [ ] **Step 7: Prove update-check and tamper behavior**

Run update `--check` after deleting `cipherpol.lock` and assert the file remains absent. Copy the registry to a temporary directory, append one byte to the task-router artifact without changing its digest, and run setup against it.

Expected: update-check writes nothing; tampered setup exits 2 with `ARTIFACT_MISMATCH` and does not replace active runtime state.

- [ ] **Step 8: Commit**

```bash
git add .gitignore README.md package.json fixtures examples packages
git commit -m "test: prove Cipherpol local generation contracts"
```

## Completion evidence

The implementation handoff must include:

- `pnpm verify` result and test count;
- `pnpm smoke:local` generation ID;
- proof that `update --check` wrote no lock;
- proof that tampering returned `ARTIFACT_MISMATCH` without replacing active state;
- generated agent, skill, metadata, and lock paths;
- parsed parity baseline counts;
- any plan deviation and its approved design reason.
