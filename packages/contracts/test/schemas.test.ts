import assert from "node:assert/strict";
import test from "node:test";
import {
  cipherpolManifestSchema,
  closureManifestSchema,
  packageRecordSchema,
  parityEntryV2Schema,
  parityManifestSchema,
  parityManifestV1Schema,
  parityManifestV2Schema,
  registryEnvelopeSchema,
} from "../src/index.js";
import type {
  ClosureManifest,
  ClosureMcpMapping,
  ClosurePackageMapping,
  PackageRecord,
  RegistryEnvelope,
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

const stage1ParityManifest = {
  schemaVersion: "cipherpol.parity/v1",
  sourceMarketplaceRevision: "0123456789abcdef",
  baseline: {
    userFacing: 34,
    skills: 67,
    agents: 47,
    references: 36,
    cp1Tools: 17,
  },
  entries: [{
    id: "cipherpol.aegis/agent/task-router",
    sourcePath: "fixtures/local-registry/artifacts/task-router/task-router.md",
    artifactType: "agent",
    shipped: true,
    state: "equivalent",
    composition: [],
    dependencies: [],
    platforms: ["flutter", "android", "ios", "web-nextjs"],
    evidence: ["Stage 1 compatibility fixture"],
  }],
};

function parityEntry(
  artifactType: "orchestrator" | "internal-procedure" | "contract" | "agent" | "reference" | "mcp-tool" | "taxonomy",
  index: number,
  userInvocable?: true,
) {
  return {
    id: `cipherpol.aegis/${artifactType}/entry-${index}`,
    name: `entry-${index}`,
    module: "cipherpol-aegis" as const,
    moduleVersion: "16.0.1",
    sourceRevision: "0123456789abcdef",
    sourcePath: `source/${artifactType}/entry-${index}.md`,
    artifactType,
    shipped: true as const,
    state: "equivalent" as const,
    ...(userInvocable === true ? { userInvocable } : {}),
    composition: [] as string[],
    dependencies: [] as string[],
    platforms: [] as string[],
    permissions: [] as string[],
    toolCapabilities: [] as string[],
    mcpCapabilities: [] as string[],
    evidence: ["source evidence"],
  };
}

function completeV2Manifest() {
  const entries = [
    ...Array.from({ length: 34 }, (_, index) => parityEntry("orchestrator", index, true)),
    ...Array.from({ length: 32 }, (_, index) => parityEntry("internal-procedure", index + 34)),
    parityEntry("contract", 66),
    ...Array.from({ length: 47 }, (_, index) => parityEntry("agent", index + 67)),
    ...Array.from({ length: 36 }, (_, index) => parityEntry("reference", index + 114)),
    ...Array.from({ length: 17 }, (_, index) => parityEntry("mcp-tool", index + 150)),
    parityEntry("taxonomy", 167),
  ];
  return {
    schemaVersion: "cipherpol.parity/v2" as const,
    sourceMarketplaceRevision: "0123456789abcdef",
    baseline: {
      userFacing: 34 as const,
      skills: 67 as const,
      agents: 47 as const,
      references: 36 as const,
      cp1Tools: 17 as const,
      classifiedEntries: 167 as const,
      taxonomies: 1 as const,
    },
    entries,
  };
}

test("parses the unchanged Stage 1 parity v1 contract", () => {
  assert.equal(parityManifestV1Schema.parse(stage1ParityManifest).schemaVersion, "cipherpol.parity/v1");
  assert.equal(parityManifestSchema.parse(stage1ParityManifest).schemaVersion, "cipherpol.parity/v1");
});

test("dispatches parity versions while keeping the v2 parser narrow", () => {
  const manifest = completeV2Manifest();
  assert.equal(parityManifestV2Schema.parse(manifest).schemaVersion, "cipherpol.parity/v2");
  assert.equal(parityManifestSchema.parse(manifest).schemaVersion, "cipherpol.parity/v2");
  assert.throws(() => parityManifestV2Schema.parse(stage1ParityManifest));
});

test("parity v2 requires approval only for explicitly unsupported entries", () => {
  const entry = parityEntry("agent", 0);
  assert.equal(parityEntryV2Schema.parse({
    ...entry,
    state: "explicitly-unsupported",
    decisionReference: "ADR-012",
  }).decisionReference, "ADR-012");
  assert.throws(() => parityEntryV2Schema.parse({
    ...entry,
    state: "explicitly-unsupported",
  }));
  assert.throws(() => parityEntryV2Schema.parse({
    ...entry,
    decisionReference: "ADR-012",
  }));
  assert.throws(() => parityEntryV2Schema.parse({
    ...entry,
    state: "normalized-dependency",
    decisionReference: "ADR-012",
  }));
  assert.throws(() => parityEntryV2Schema.parse({
    ...entry,
    state: "generic-fallback",
  }));
});

test("parity v2 rejects dangling relationships at the relationship item path", () => {
  const manifest = completeV2Manifest();
  manifest.entries[0]!.composition.push("cipherpol.aegis/agent/missing-composition");
  manifest.entries[0]!.dependencies.push("cipherpol.aegis/agent/missing-dependency");
  const result = parityManifestV2Schema.safeParse(manifest);
  assert.equal(result.success, false);
  if (result.success) return;
  assert.ok(result.error.issues.some((issue) =>
    issue.path.join(".") === "entries.0.composition.0"
  ));
  assert.ok(result.error.issues.some((issue) =>
    issue.path.join(".") === "entries.0.dependencies.0"
  ));
});

test("parity v2 rejects measured count drift despite literal baseline declarations", () => {
  const manifest = completeV2Manifest();
  manifest.entries.splice(67, 1);
  const result = parityManifestV2Schema.safeParse(manifest);
  assert.equal(result.success, false);
  if (result.success) return;
  assert.ok(result.error.issues.some((issue) => issue.path.join(".") === "baseline.agents"));
  assert.ok(result.error.issues.some((issue) => issue.path.join(".") === "baseline.classifiedEntries"));
});

function fixtureDigest(index: number): string {
  return `sha256:${index.toString(16).padStart(64, "0")}`;
}

function closurePackage(index: number): PackageRecord {
  return {
    id: `cipherpol.test/package-${index}`,
    kind: "skill",
    version: `1.0.${index}`,
    digest: fixtureDigest(index + 1),
    owner: "contract-tests",
    sourceRevision: "0123456789abcdef",
    artifactPath: `artifacts/package-${index}`,
    compatibility: { claudeCode: ">=2.1.0", capabilities: [] },
    dependencies: [],
    files: [{
      source: `source/package-${index}.md`,
      target: `skills/package-${index}/SKILL.md`,
      mode: 0o644,
    }],
    revoked: false,
  };
}

function closurePackageMapping(
  packageRecord: PackageRecord,
  index: number,
): ClosurePackageMapping {
  return {
    parityId: `cipherpol.parity/entry-${index}`,
    mappingType: "package",
    packageId: packageRecord.id,
    packageVersion: packageRecord.version,
    packageDigest: packageRecord.digest,
    admissionPath: `admissions/package-${index}.json`,
  };
}

function closureMcpMapping(
  adapter: PackageRecord,
  index: number,
): ClosureMcpMapping {
  return {
    parityId: `cipherpol.parity/mcp-${index}`,
    mappingType: "mcp-tool",
    packageId: adapter.id,
    packageVersion: adapter.version,
    packageDigest: adapter.digest,
    admissionPath: "admissions/adapter-cp1.json",
    capability: `cp1_tool_${index}`,
  };
}

function validClosureFixture(): ClosureManifest {
  const packages = Array.from({ length: 151 }, (_, index) => closurePackage(index));
  const adapter: PackageRecord = {
    ...closurePackage(151),
    id: "cipherpol.test/adapter-cp1",
    kind: "adapter",
    version: "1.0.0",
  };

  return {
    schemaVersion: "cipherpol.closure/v1",
    sourceRevision: "0123456789abcdef",
    paritySchemaVersion: "cipherpol.parity/v2",
    parityManifestDigest: fixtureDigest(1000),
    mappings: [
      ...packages.map(closurePackageMapping),
      ...Array.from(
        { length: 17 },
        (_, index) => closureMcpMapping(adapter, index),
      ),
    ],
  };
}

function validRegistryEnvelopeFixture(): RegistryEnvelope {
  return {
    schemaVersion: "cipherpol.registry-envelope/v1",
    registryIndex: {
      schemaVersion: "cipherpol.registry/v1",
      packages: [
        ...Array.from({ length: 151 }, (_, index) => closurePackage(index)),
        {
          ...closurePackage(151),
          id: "cipherpol.test/adapter-cp1",
          kind: "adapter",
          version: "1.0.0",
        },
      ],
      capabilityPacks: [],
      playbooks: [],
    },
    closureManifest: validClosureFixture(),
    keyId: "fixture-stage2",
    algorithm: "Ed25519",
    keyPurpose: "fixture",
    signature: "test-signature",
  };
}

test("keeps Stage 1 package records compatible without a file mode", () => {
  const parsed: PackageRecord = packageRecordSchema.parse(validPackage);
  assert.equal(parsed.files[0]!.mode, undefined);
});

test("accepts only normalized 0644 and 0755 package file modes", () => {
  assert.equal(packageRecordSchema.parse({
    ...validPackage,
    files: [{ ...validPackage.files[0], mode: 0o644 }],
  }).files[0]!.mode, 0o644);
  assert.equal(packageRecordSchema.parse({
    ...validPackage,
    files: [{ ...validPackage.files[0], mode: 0o755 }],
  }).files[0]!.mode, 0o755);
  for (const mode of [0o600, 0o700, 0o777]) {
    assert.throws(() => packageRecordSchema.parse({
      ...validPackage,
      files: [{ ...validPackage.files[0], mode }],
    }));
  }
});

test("parses a complete 168-entry closure and its 152-package registry envelope", () => {
  const closure: ClosureManifest = closureManifestSchema.parse(validClosureFixture());
  assert.equal(closure.mappings.length, 168);
  const envelope: RegistryEnvelope = registryEnvelopeSchema.parse(validRegistryEnvelopeFixture());
  assert.equal(envelope.registryIndex.packages.length, 152);
});

test("rejects duplicate closure parity mappings", () => {
  const closure = validClosureFixture();
  closure.mappings[1]!.parityId = closure.mappings[0]!.parityId;
  assert.throws(() => closureManifestSchema.parse(closure), /closure parity IDs must be unique/);
});

test("requires exactly 17 distinct MCP capabilities on one adapter descriptor", () => {
  const duplicateCapability = validClosureFixture();
  const mcpMappings = duplicateCapability.mappings.filter(
    (mapping) => mapping.mappingType === "mcp-tool",
  );
  mcpMappings[1]!.capability = mcpMappings[0]!.capability;
  assert.throws(
    () => closureManifestSchema.parse(duplicateCapability),
    /MCP capabilities must be distinct/,
  );

  const tooFew = validClosureFixture();
  tooFew.mappings.pop();
  assert.throws(
    () => closureManifestSchema.parse(tooFew),
    /exactly 17 MCP mappings/,
  );

  const splitAdapter = validClosureFixture();
  const splitMapping = splitAdapter.mappings.find(
    (mapping) => mapping.mappingType === "mcp-tool",
  );
  assert.ok(splitMapping && splitMapping.mappingType === "mcp-tool");
  splitMapping.admissionPath = "admissions/other-adapter.json";
  assert.throws(
    () => closureManifestSchema.parse(splitAdapter),
    /share one adapter descriptor/,
  );
});

test("rejects closure mappings to unknown registry packages", () => {
  const envelope = validRegistryEnvelopeFixture();
  envelope.closureManifest.mappings[0]!.packageId = "cipherpol.test/unknown";
  assert.throws(
    () => registryEnvelopeSchema.parse(envelope),
    /unknown registry package/,
  );
});

test("rejects closure package versions and digests that disagree with the registry", () => {
  const versionMismatch = validRegistryEnvelopeFixture();
  versionMismatch.closureManifest.mappings[0]!.packageVersion = "99.0.0";
  assert.throws(
    () => registryEnvelopeSchema.parse(versionMismatch),
    /version does not match registry package/,
  );

  const digestMismatch = validRegistryEnvelopeFixture();
  digestMismatch.closureManifest.mappings[0]!.packageDigest = fixtureDigest(9999);
  assert.throws(
    () => registryEnvelopeSchema.parse(digestMismatch),
    /digest does not match registry package/,
  );
});

test("requires every registry package to have at least one closure mapping", () => {
  const envelope = validRegistryEnvelopeFixture();
  envelope.registryIndex.packages.push(closurePackage(200));
  assert.throws(
    () => registryEnvelopeSchema.parse(envelope),
    /every registry package must have a closure mapping/,
  );
});
