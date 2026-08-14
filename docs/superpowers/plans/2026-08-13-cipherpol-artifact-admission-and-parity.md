# Cipherpol Artifact Admission and Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build deterministic package admission, provenance verification, graph and context validation gates, a `software-dev-agentic` artifact importer, and the authoritative semantic parity manifest suite for Cipherpol Stage 2: 167 classified entries plus one separately accounted taxonomy, 168 entries total.

**Architecture:** Create `@cipherpol/admission` workspace package. Admission validates artifact structures, content hashes, security patterns, dependency DAGs, procedure inclusion graphs (`check_procedures`), and agent context scoping (`check_agent_context`). The importer reads only authored sources selected by each module's build configuration, preserves source provenance and semantics in `cipherpol.parity/v2`, and leaves `PackageRecord` digest generation to the admission pipeline after real artifact directories exist. The original `cipherpol.parity/v1` remains a Stage 1 compatibility contract.

**Tech Stack:** Node.js 20+, TypeScript 5, pnpm workspaces, Zod 4, YAML 2, semver 7, `@cipherpol/contracts`, `@cipherpol/resolver`, Node test runner (`tsx --test`).

---

## File map

```text
pnpm-workspace.yaml                       updated workspace packages list
packages/admission/package.json           admission package config
packages/admission/tsconfig.json          admission TypeScript config
packages/admission/src/errors.ts          admission error codes and CipherpolAdmissionError
packages/admission/src/security.ts        secret and unsafe pattern scanning
packages/admission/src/graph.ts           dependency DAG and cycle detection
packages/admission/src/checks.ts          check_procedures and check_agent_context gates
packages/admission/src/admission.ts      package record admission pipeline
packages/admission/src/importer.ts       software-dev-agentic source importer
packages/admission/src/parity.ts         authoritative parity manifest builder and validator
packages/admission/src/cli.ts            admission and import CLI
packages/admission/src/index.ts          package export entry point
packages/admission/test/admission.test.ts admission and security validation tests
packages/admission/test/checks.test.ts    procedure graph and agent context tests
packages/admission/test/importer.test.ts  software-dev-agentic importer tests
packages/admission/test/parity.test.ts    authoritative parity baseline verification tests
```

---

### Task 1: Establish `@cipherpol/admission` package workspace

**Files:**
- Modify: `pnpm-workspace.yaml`
- Create: `packages/admission/package.json`
- Create: `packages/admission/tsconfig.json`
- Create: `packages/admission/src/errors.ts`
- Create: `packages/admission/src/index.ts`
- Test: `packages/admission/test/errors.test.ts`

- [ ] **Step 1: Write failing test for error types**

Create `packages/admission/test/errors.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { CipherpolAdmissionError } from "../src/index.js";

test("creates structured admission error with code and details", () => {
  const error = new CipherpolAdmissionError("INVALID_NAMESPACE", "Bad namespace", { id: "bad-id" });
  assert.equal(error.name, "CipherpolAdmissionError");
  assert.equal(error.code, "INVALID_NAMESPACE");
  assert.equal(error.details["id"], "bad-id");
  assert.equal(error.message, "Bad namespace");
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @cipherpol/admission test`
Expected: FAIL because `packages/admission` does not exist yet in workspace.

- [ ] **Step 3: Create package configuration files**

Update `pnpm-workspace.yaml`:

```yaml
packages:
  - packages/*
```

Create `packages/admission/package.json`:

```json
{
  "name": "@cipherpol/admission",
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
    "@cipherpol/resolver": "workspace:*",
    "semver": "^7.7.2",
    "yaml": "^2.8.1",
    "zod": "^4.1.5"
  },
  "devDependencies": {
    "@types/node": "^24.3.0",
    "@types/semver": "^7.7.0",
    "tsx": "^4.20.5",
    "typescript": "^5.9.2"
  }
}
```

Create `packages/admission/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `packages/admission/src/errors.ts`:

```ts
export type AdmissionErrorCode =
  | "INVALID_NAMESPACE"
  | "SECRET_DETECTED"
  | "UNSAFE_PATTERN"
  | "DEPENDENCY_CYCLE"
  | "MISSING_DEPENDENCY"
  | "INVALID_PROCEDURE_GRAPH"
  | "INVALID_AGENT_CONTEXT"
  | "PROVENANCE_MISMATCH"
  | "PARITY_BASELINE_VIOLATION";

export class CipherpolAdmissionError extends Error {
  constructor(
    readonly code: AdmissionErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CipherpolAdmissionError";
  }
}
```

Create `packages/admission/src/index.ts`:

```ts
export * from "./errors.js";
```

- [ ] **Step 4: Run pnpm install and run tests**

Run: `pnpm install && pnpm --filter @cipherpol/admission test`
Expected: PASS 1 test.

- [ ] **Step 5: Commit**

```bash
git add pnpm-workspace.yaml packages/admission package.json pnpm-lock.yaml
git commit -m "chore: establish @cipherpol/admission package workspace"
```

---

### Task 2: Implement security scanning and dependency DAG validation

**Files:**
- Create: `packages/admission/src/security.ts`
- Create: `packages/admission/src/graph.ts`
- Modify: `packages/admission/src/index.ts`
- Test: `packages/admission/test/security.test.ts`
- Test: `packages/admission/test/graph.test.ts`

- [ ] **Step 1: Write failing security and graph tests**

Create `packages/admission/test/security.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { scanArtifactSecurity } from "../src/security.js";
import { CipherpolAdmissionError } from "../src/errors.js";

test("detects unredacted secret tokens", () => {
  const content = 'const key = "sk-proj-1234567890abcdef1234567890abcdef";';
  assert.throws(
    () => scanArtifactSecurity("auth.ts", content),
    (err: unknown) => err instanceof CipherpolAdmissionError && err.code === "SECRET_DETECTED",
  );
});

test("passes clean artifact content", () => {
  const content = 'export function sanitize(input: string): string { return input.trim(); }';
  assert.doesNotThrow(() => scanArtifactSecurity("clean.ts", content));
});
```

Create `packages/admission/test/graph.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { validateDependencyGraph } from "../src/graph.js";
import { CipherpolAdmissionError } from "../src/errors.js";

test("detects cyclic package dependencies", () => {
  const packages = [
    { id: "cipherpol.aegis/agent/a", dependencies: ["cipherpol.aegis/agent/b@1.0.0"] },
    { id: "cipherpol.aegis/agent/b", dependencies: ["cipherpol.aegis/agent/a@1.0.0"] },
  ];
  assert.throws(
    () => validateDependencyGraph(packages),
    (err: unknown) => err instanceof CipherpolAdmissionError && err.code === "DEPENDENCY_CYCLE",
  );
});

test("validates acyclic dependency graph", () => {
  const packages = [
    { id: "cipherpol.aegis/agent/a", dependencies: ["cipherpol.aegis/skill/b@1.0.0"] },
    { id: "cipherpol.aegis/skill/b", dependencies: [] },
  ];
  assert.doesNotThrow(() => validateDependencyGraph(packages));
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @cipherpol/admission test`
Expected: FAIL because `security.ts` and `graph.ts` do not exist yet.

- [ ] **Step 3: Implement security scanner**

Create `packages/admission/src/security.ts`:

```ts
import { CipherpolAdmissionError } from "./errors.js";

const SECRET_PATTERNS = [
  /(?:sk-[a-zA-Z0-9]{20,})/g,
  /(?:ghp_[a-zA-Z0-9]{36})/g,
  /(?:glpat-[a-zA-Z0-9_-]{20})/g,
  /-----BEGIN PRIVATE KEY-----/g,
];

export function scanArtifactSecurity(filePath: string, content: string): void {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      throw new CipherpolAdmissionError(
        "SECRET_DETECTED",
        `Potential secret credential detected in ${filePath}`,
        { filePath },
      );
    }
  }
}
```

- [ ] **Step 4: Implement dependency graph validator**

Create `packages/admission/src/graph.ts`:

```ts
import { CipherpolAdmissionError } from "./errors.js";

export interface PackageDependencyNode {
  id: string;
  dependencies: string[];
}

function parseRefId(ref: string): string {
  const atIndex = ref.lastIndexOf("@");
  return atIndex > 0 ? ref.slice(0, atIndex) : ref;
}

export function validateDependencyGraph(nodes: PackageDependencyNode[]): void {
  const graph = new Map<string, string[]>();
  for (const node of nodes) {
    graph.set(
      node.id,
      node.dependencies.map(parseRefId),
    );
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(nodeId: string, path: string[]): void {
    visited.add(nodeId);
    inStack.add(nodeId);

    const deps = graph.get(nodeId) ?? [];
    for (const depId of deps) {
      if (inStack.has(depId)) {
        throw new CipherpolAdmissionError(
          "DEPENDENCY_CYCLE",
          `Dependency cycle detected: ${[...path, nodeId, depId].join(" -> ")}`,
          { cycle: [...path, nodeId, depId] },
        );
      }
      if (!visited.has(depId) && graph.has(depId)) {
        dfs(depId, [...path, nodeId]);
      }
    }
    inStack.delete(nodeId);
  }

  for (const nodeId of graph.keys()) {
    if (!visited.has(nodeId)) {
      dfs(nodeId, []);
    }
  }
}
```

- [ ] **Step 5: Export modules in `packages/admission/src/index.ts`**

Update `packages/admission/src/index.ts`:

```ts
export * from "./errors.js";
export * from "./security.js";
export * from "./graph.ts";
```

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm --filter @cipherpol/admission test && pnpm --filter @cipherpol/admission typecheck`
Expected: PASS 3 tests; typecheck exits zero.

- [ ] **Step 7: Commit**

```bash
git add packages/admission
git commit -m "feat: implement security scanning and dependency DAG validation"
```

---

### Task 3: Implement procedure graph and agent context admission gates

**Files:**
- Create: `packages/admission/src/checks.ts`
- Modify: `packages/admission/src/index.ts`
- Test: `packages/admission/test/checks.test.ts`

- [ ] **Step 1: Write failing admission check tests**

Create `packages/admission/test/checks.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { checkProcedures, checkAgentContext } from "../src/checks.js";
import { CipherpolAdmissionError } from "../src/errors.js";

test("checkProcedures rejects missing procedure targets", () => {
  const packages = [
    {
      id: "cipherpol.aegis/procedure/p1",
      kind: "procedure" as const,
      filesContent: [{ path: "p1.md", content: "include: cipherpol.aegis/procedure/nonexistent" }],
    },
  ];
  assert.throws(
    () => checkProcedures(packages),
    (err: unknown) => err instanceof CipherpolAdmissionError && err.code === "INVALID_PROCEDURE_GRAPH",
  );
});

test("checkProcedures passes valid procedure graph", () => {
  const packages = [
    {
      id: "cipherpol.aegis/procedure/p1",
      kind: "procedure" as const,
      filesContent: [{ path: "p1.md", content: "include: cipherpol.aegis/procedure/p2" }],
    },
    {
      id: "cipherpol.aegis/procedure/p2",
      kind: "procedure" as const,
      filesContent: [{ path: "p2.md", content: "Step 1: Execute clean build" }],
    },
  ];
  assert.doesNotThrow(() => checkProcedures(packages));
});

test("checkAgentContext enforces project-root scoping for search agents", () => {
  const un-scopedAgent = {
    id: "cipherpol.aegis/agent/scout",
    kind: "agent" as const,
    filesContent: [{ path: "scout.md", content: "Search anywhere on the system filesystem" }],
  };
  assert.throws(
    () => checkAgentContext([un-scopedAgent]),
    (err: unknown) => err instanceof CipherpolAdmissionError && err.code === "INVALID_AGENT_CONTEXT",
  );
});

test("checkAgentContext passes project-root scoped searching agent", () => {
  const scopedAgent = {
    id: "cipherpol.aegis/agent/scout",
    kind: "agent" as const,
    filesContent: [{ path: "scout.md", content: "Search strictly within the workspace project-root directory" }],
  };
  assert.doesNotThrow(() => checkAgentContext([scopedAgent]));
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @cipherpol/admission test`
Expected: FAIL because `checks.ts` does not exist yet.

- [ ] **Step 3: Implement admission checks (`check_procedures` and `check_agent_context`)**

Create `packages/admission/src/checks.ts`:

```ts
import { CipherpolAdmissionError } from "./errors.js";

export interface PackageFileContent {
  path: string;
  content: string;
}

export interface CheckablePackage {
  id: string;
  kind: "agent" | "skill" | "procedure" | "reference" | "hook" | "validator" | "adapter" | "bootstrap";
  filesContent: PackageFileContent[];
}

export function checkProcedures(packages: CheckablePackage[]): void {
  const validIds = new Set(packages.map((pkg) => pkg.id));
  const includePattern = /include:\s*([a-z0-9.-]+\/[a-z0-9._/-]+)/gi;

  for (const pkg of packages) {
    if (pkg.kind !== "procedure" && pkg.kind !== "skill") continue;
    for (const file of pkg.filesContent) {
      let match: RegExpExecArray | null;
      while ((match = includePattern.exec(file.content)) !== null) {
        const targetId = match[1];
        if (targetId && !validIds.has(targetId)) {
          throw new CipherpolAdmissionError(
            "INVALID_PROCEDURE_GRAPH",
            `Procedure ${pkg.id} includes non-existent target ${targetId}`,
            { packageId: pkg.id, missingTarget: targetId },
          );
        }
      }
    }
  }
}

export function checkAgentContext(packages: CheckablePackage[]): void {
  for (const pkg of packages) {
    if (pkg.kind !== "agent") continue;
    for (const file of pkg.filesContent) {
      const lower = file.content.toLowerCase();
      if (lower.includes("search anywhere on the system") || lower.includes("search system root")) {
        throw new CipherpolAdmissionError(
          "INVALID_AGENT_CONTEXT",
          `Agent ${pkg.id} has unsafe un-scoped search instructions`,
          { packageId: pkg.id, file: file.path },
        );
      }
    }
  }
}
```

- [ ] **Step 4: Update exports in `packages/admission/src/index.ts`**

Update `packages/admission/src/index.ts`:

```ts
export * from "./errors.js";
export * from "./security.js";
export * from "./graph.js";
export * from "./checks.js";
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @cipherpol/admission test && pnpm --filter @cipherpol/admission typecheck`
Expected: PASS 7 tests; typecheck exits zero.

- [ ] **Step 6: Commit**

```bash
git add packages/admission
git commit -m "feat: implement check_procedures and check_agent_context admission gates"
```

---

### Task 4: Implement package record admission pipeline

**Files:**
- Create: `packages/admission/src/admission.ts`
- Modify: `packages/admission/src/index.ts`
- Test: `packages/admission/test/admission.test.ts`

- [ ] **Step 1: Write failing admission pipeline tests**

Create `packages/admission/test/admission.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { admitPackage } from "../src/admission.js";
import { CipherpolAdmissionError } from "../src/errors.js";

async function createPackageArtifact(): Promise<{ dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cipherpol-admit-"));
  await mkdir(join(dir, "artifacts/task-router"), { recursive: true });
  await writeFile(join(dir, "artifacts/task-router/task-router.md"), "# Task Router\nClean content.");
  return { dir };
}

test("admits a valid package record", async () => {
  const { dir } = await createPackageArtifact();
  const pkgRecord = await admitPackage(dir, {
    id: "cipherpol.aegis/agent/task-router",
    kind: "agent",
    version: "1.0.0",
    owner: "mobile-platform",
    sourceRevision: "0123456789abcdef",
    artifactPath: "artifacts/task-router",
    compatibility: { claudeCode: ">=2.1.0", capabilities: ["plugins"] },
    dependencies: [],
    files: [{ source: "task-router.md", target: "agents/task-router.md" }],
  });
  assert.equal(pkgRecord.id, "cipherpol.aegis/agent/task-router");
  assert.match(pkgRecord.digest, /^sha256:[a-f0-9]{64}$/);
});

test("rejects non-namespaced package ID during admission", async () => {
  const { dir } = await createPackageArtifact();
  await assert.rejects(
    admitPackage(dir, {
      id: "task-router",
      kind: "agent",
      version: "1.0.0",
      owner: "mobile-platform",
      sourceRevision: "0123456789abcdef",
      artifactPath: "artifacts/task-router",
      compatibility: { claudeCode: ">=2.1.0", capabilities: ["plugins"] },
      dependencies: [],
      files: [{ source: "task-router.md", target: "agents/task-router.md" }],
    }),
    (err: unknown) => err instanceof CipherpolAdmissionError && err.code === "INVALID_NAMESPACE",
  );
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @cipherpol/admission test`
Expected: FAIL because `admission.ts` does not exist.

- [ ] **Step 3: Implement admission pipeline**

Create `packages/admission/src/admission.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageRecordSchema, type PackageRecord } from "@cipherpol/contracts";
import { digestDirectory } from "@cipherpol/resolver";
import { CipherpolAdmissionError } from "./errors.js";
import { scanArtifactSecurity } from "./security.js";

export interface PackageInputMetadata {
  id: string;
  kind: "agent" | "skill" | "procedure" | "reference" | "hook" | "validator" | "adapter" | "bootstrap";
  version: string;
  owner: string;
  sourceRevision: string;
  artifactPath: string;
  compatibility: { claudeCode: string; capabilities: string[] };
  dependencies: string[];
  files: Array<{ source: string; target: string }>;
}

export async function admitPackage(
  registryRoot: string,
  input: PackageInputMetadata,
): Promise<PackageRecord> {
  if (!input.id.includes("/")) {
    throw new CipherpolAdmissionError("INVALID_NAMESPACE", `Package ID must be namespaced: ${input.id}`, { id: input.id });
  }

  const fullArtifactPath = join(registryRoot, input.artifactPath);
  const digest = await digestDirectory(fullArtifactPath);

  for (const file of input.files) {
    const fullFilePath = join(fullArtifactPath, file.source);
    try {
      const content = await readFile(fullFilePath, "utf8");
      scanArtifactSecurity(file.source, content);
    } catch (err) {
      if (err instanceof CipherpolAdmissionError) throw err;
    }
  }

  const rawRecord = {
    ...input,
    digest,
    revoked: false,
  };

  try {
    return packageRecordSchema.parse(rawRecord);
  } catch (cause) {
    throw new CipherpolAdmissionError(
      "INVALID_NAMESPACE",
      `Package record schema validation failed for ${input.id}`,
      { cause: String(cause) },
    );
  }
}
```

- [ ] **Step 4: Update exports in `packages/admission/src/index.ts`**

Update `packages/admission/src/index.ts`:

```ts
export * from "./errors.js";
export * from "./security.js";
export * from "./graph.js";
export * from "./checks.js";
export * from "./admission.js";
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @cipherpol/admission test && pnpm --filter @cipherpol/admission typecheck`
Expected: PASS 9 tests; typecheck exits zero.

- [ ] **Step 6: Commit**

```bash
git add packages/admission
git commit -m "feat: implement package record admission pipeline"
```

---

### Task 5: Implement `software-dev-agentic` artifact importer and parity manifest validator

**Files:**
- Create: `packages/admission/src/importer.ts`
- Create: `packages/admission/src/parity.ts`
- Modify: `packages/admission/src/index.ts`
- Modify: `packages/contracts/src/schemas.ts`
- Modify: `packages/contracts/src/models.ts`
- Test: `packages/admission/test/importer.test.ts`
- Test: `packages/admission/test/parity.test.ts`

- [ ] Parse and cross-check the exact module `VERSION` files and marketplace versions for cipherpol-aegis 16.0.1, cipherpol-9 13.14.0, and cipherpol-1 0.2.0.
- [ ] Reproduce each `plugin/build.config.json` source selection without reading `dist/`, rejecting flattened target collisions.
- [ ] Parse authored YAML frontmatter and cp1's 17 literal `server.registerTool` declarations; reject malformed or changed source shapes rather than guessing.
- [ ] Generate stable module/kind/name IDs and evidence-rich `cipherpol.parity/v2` entries for 34 orchestrators, 32 internal procedures, one platform contract, 47 agents, 36 Markdown references, 17 cp1 MCP tools, and one separately accounted taxonomy: 167 classified entries plus the taxonomy, 168 total.
- [ ] Keep package digests out of importer output until the admission pipeline supplies real copied artifact directories.
- [ ] Verify the 167 classified-entry contract plus one taxonomy, 168 entries total, through fixture-driven portable unit tests plus an opt-in real-source integration path.

---

### Task 6: Admission CLI and orchestration (deferred)

CLI and admission orchestration are outside the source-faithful importer/parity scope.
Any future entry point must call `measureSoftwareDevAgenticCorpus` with an explicit
repository root and source revision; it must not synthesize parity records.

## Completion evidence

The implementation handoff must include:
- `pnpm verify` output showing 0 typecheck errors and 100% passing tests across all 3 workspace packages (`@cipherpol/contracts`, `@cipherpol/resolver`, `@cipherpol/admission`);
- `pnpm verify:parity` output demonstrating full validation of 167 classified parity entries (34 user-facing, 67 total skills, 47 agents, 36 references, 17 cp1 tools) plus one separately accounted taxonomy, 168 entries total;
- Proof of admission validation checks (`check_procedures`, `check_agent_context`, DAG cycle detection, secret scanning);
- Git commit log showing clean atomic commits for Stage 2.
