import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { ClosureManifest, ParityEntryV2, ParityManifestV2, PackageRecord, RegistryIndex } from "@cipherpol/contracts";
import {
  CipherpolAdmissionError,
  composeClosureManifest,
  composeClosureRegistry,
  type ImportedArtifactDescriptor,
  type PackageAdmissionEnvelope,
  SOFTWARE_DEV_AGENTIC_BASELINE,
  signRegistryEnvelope,
  verifyRegistryEnvelope,
} from "../src/index.js";

const SOURCE_REVISION = "a8afa8dd0848833b72ef536e1258d5c27bb8e3fc";
const MCP_TOOL_COUNT = 17;

function fakeDigest(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

function baseEntryFields(id: string): Pick<
  ParityEntryV2,
  | "sourceRevision"
  | "sourcePath"
  | "shipped"
  | "composition"
  | "dependencies"
  | "platforms"
  | "permissions"
  | "toolCapabilities"
  | "mcpCapabilities"
  | "evidence"
> {
  return {
    sourceRevision: SOURCE_REVISION,
    sourcePath: `source/${id}`,
    shipped: true,
    composition: [],
    dependencies: [],
    platforms: [],
    permissions: [],
    toolCapabilities: [],
    mcpCapabilities: [],
    evidence: [`evidence:${id}`],
  };
}

function buildMiniatureParityManifest(): { parity: ParityManifestV2; mcpEntryIds: string[] } {
  const skillEntry: ParityEntryV2 = {
    ...baseEntryFields("cipherpol-aegis/skill/foo"),
    id: "cipherpol-aegis/skill/foo",
    name: "Foo Skill",
    module: "cipherpol-aegis",
    moduleVersion: "1.0.0",
    artifactType: "orchestrator",
    userInvocable: true,
    state: "equivalent",
  };
  const agentEntry: ParityEntryV2 = {
    ...baseEntryFields("cipherpol-aegis/agent/bar"),
    id: "cipherpol-aegis/agent/bar",
    name: "Bar Agent",
    module: "cipherpol-aegis",
    moduleVersion: "1.0.0",
    artifactType: "agent",
    state: "equivalent",
  };
  const referenceEntry: ParityEntryV2 = {
    ...baseEntryFields("cipherpol-aegis/reference/baz"),
    id: "cipherpol-aegis/reference/baz",
    name: "Baz Reference",
    module: "cipherpol-aegis",
    moduleVersion: "1.0.0",
    artifactType: "reference",
    state: "equivalent",
  };

  const mcpEntries: ParityEntryV2[] = [];
  for (let index = 1; index <= MCP_TOOL_COUNT; index += 1) {
    const id = `cipherpol-1/mcp-tool/tool-${String(index).padStart(2, "0")}`;
    mcpEntries.push({
      ...baseEntryFields(id),
      id,
      name: `Tool ${index}`,
      module: "cipherpol-1",
      moduleVersion: "2.0.0",
      artifactType: "mcp-tool",
      mcpCapabilities: [`cp1_tool_${String(index).padStart(2, "0")}`],
      state: "equivalent",
    });
  }

  const parity: ParityManifestV2 = {
    schemaVersion: "cipherpol.parity/v2",
    sourceMarketplaceRevision: SOURCE_REVISION,
    baseline: SOFTWARE_DEV_AGENTIC_BASELINE,
    entries: [skillEntry, agentEntry, referenceEntry, ...mcpEntries],
  };

  return { parity, mcpEntryIds: mcpEntries.map((entry) => entry.id) };
}

function buildDescriptors(mcpEntryIds: readonly string[]): ImportedArtifactDescriptor[] {
  return [
    {
      packageId: "cipherpol-aegis/skill/foo",
      parityIds: ["cipherpol-aegis/skill/foo"],
      module: "cipherpol-aegis",
      moduleVersion: "1.0.0",
      packageKind: "skill",
      sourceKind: "directory",
      sourcePaths: ["skills/foo"],
      targetRoot: "skills/foo",
    },
    {
      packageId: "cipherpol-aegis/agent/bar",
      parityIds: ["cipherpol-aegis/agent/bar"],
      module: "cipherpol-aegis",
      moduleVersion: "1.0.0",
      packageKind: "agent",
      sourceKind: "file",
      sourcePaths: ["agents/bar.md"],
      targetRoot: "agents/bar.md",
    },
    {
      packageId: "cipherpol-aegis/reference/baz",
      parityIds: ["cipherpol-aegis/reference/baz"],
      module: "cipherpol-aegis",
      moduleVersion: "1.0.0",
      packageKind: "reference",
      sourceKind: "file",
      sourcePaths: ["references/baz.md"],
      targetRoot: "references/baz.md",
    },
    {
      packageId: "cipherpol-1/adapter/cp1",
      parityIds: [...mcpEntryIds],
      module: "cipherpol-1",
      moduleVersion: "2.0.0",
      packageKind: "adapter",
      sourceKind: "cp1-adapter",
      sourcePaths: ["cipherpol-1/plugin"],
      targetRoot: "adapters/cp1",
    },
  ];
}

function buildPackageRecord(id: string, kind: PackageRecord["kind"]): PackageRecord {
  return {
    id,
    kind,
    version: "1.0.0",
    digest: fakeDigest(id),
    owner: "test-owner",
    sourceRevision: SOURCE_REVISION,
    artifactPath: `artifacts/${id}`,
    compatibility: { claudeCode: ">=1.0.0", capabilities: [] },
    dependencies: [],
    files: [{ source: "SKILL.md", target: `${id}/SKILL.md` }],
    revoked: false,
  };
}

function buildAdmission(record: PackageRecord): PackageAdmissionEnvelope {
  return {
    schemaVersion: "cipherpol.admission/v1",
    packageRecord: record,
    provenance: {
      sourceRepository: "https://example.test/software-dev-agentic.git",
      sourceRevision: record.sourceRevision,
      sourcePaths: [record.artifactPath],
    },
    keyId: "fixture-admission-key",
    keyPurpose: "production",
    algorithm: "Ed25519",
    signature: "ZmFrZS1zaWduYXR1cmU=",
  };
}

function buildFixture(): {
  parity: ParityManifestV2;
  descriptors: ImportedArtifactDescriptor[];
  admissions: PackageAdmissionEnvelope[];
} {
  const { parity, mcpEntryIds } = buildMiniatureParityManifest();
  const descriptors = buildDescriptors(mcpEntryIds);
  const admissions = [
    buildAdmission(buildPackageRecord("cipherpol-aegis/skill/foo", "skill")),
    buildAdmission(buildPackageRecord("cipherpol-aegis/agent/bar", "agent")),
    buildAdmission(buildPackageRecord("cipherpol-aegis/reference/baz", "reference")),
    buildAdmission(buildPackageRecord("cipherpol-1/adapter/cp1", "adapter")),
  ];
  return { parity, descriptors, admissions };
}

function captureError(action: () => unknown): CipherpolAdmissionError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof CipherpolAdmissionError);
    return error;
  }
  assert.fail("Expected CipherpolAdmissionError");
}

test("composes one package mapping per non-MCP entry and one shared-adapter mapping per MCP entry", () => {
  const { parity, descriptors, admissions } = buildFixture();
  const closure = composeClosureManifest({ parity, admissions, descriptors, admissionsRoot: "admissions" });

  assert.equal(closure.schemaVersion, "cipherpol.closure/v1");
  assert.equal(closure.sourceRevision, SOURCE_REVISION);
  assert.equal(closure.paritySchemaVersion, "cipherpol.parity/v2");
  assert.equal(closure.mappings.length, parity.entries.length);

  const byParityId = new Map(closure.mappings.map((mapping) => [mapping.parityId, mapping]));
  const skillMapping = byParityId.get("cipherpol-aegis/skill/foo");
  assert.ok(skillMapping);
  assert.equal(skillMapping.mappingType, "package");
  assert.equal(skillMapping.packageId, "cipherpol-aegis/skill/foo");
  assert.equal(skillMapping.admissionPath, "admissions/cipherpol-aegis/skill/foo.json");

  const mcpMappings = closure.mappings.filter((mapping) => mapping.mappingType === "mcp-tool");
  assert.equal(mcpMappings.length, MCP_TOOL_COUNT);
  const capabilities = new Set(mcpMappings.map((mapping) => (mapping.mappingType === "mcp-tool" ? mapping.capability : undefined)));
  assert.equal(capabilities.size, MCP_TOOL_COUNT);
  for (const mapping of mcpMappings) {
    assert.equal(mapping.packageId, "cipherpol-1/adapter/cp1");
    assert.equal(mapping.admissionPath, "admissions/cipherpol-1/adapter/cp1.json");
  }

  const parityIdsInOrder = closure.mappings.map((mapping) => mapping.parityId);
  const sorted = [...parityIdsInOrder].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  assert.deepEqual(parityIdsInOrder, sorted);
});

test("computes the parity manifest digest deterministically without hardcoding entry counts", () => {
  const { parity, descriptors, admissions } = buildFixture();
  const first = composeClosureManifest({ parity, admissions, descriptors, admissionsRoot: "admissions" });
  const second = composeClosureManifest({ parity, admissions, descriptors, admissionsRoot: "admissions" });
  assert.equal(first.parityManifestDigest, second.parityManifestDigest);
  assert.match(first.parityManifestDigest, /^sha256:[a-f0-9]{64}$/);

  const mutatedEntries = [...parity.entries];
  const targetIndex = mutatedEntries.findIndex((entry) => entry.id === "cipherpol-aegis/skill/foo");
  const target = mutatedEntries[targetIndex];
  assert.ok(target);
  mutatedEntries[targetIndex] = { ...target, name: "Renamed Foo Skill" };
  const changed = composeClosureManifest({
    parity: { ...parity, entries: mutatedEntries },
    admissions,
    descriptors,
    admissionsRoot: "admissions",
  });
  assert.notEqual(changed.parityManifestDigest, first.parityManifestDigest);
});

test("produces identical mappings regardless of descriptor and admission input order", () => {
  const { parity, descriptors, admissions } = buildFixture();
  const first = composeClosureManifest({ parity, admissions, descriptors, admissionsRoot: "admissions" });
  const second = composeClosureManifest({
    parity,
    admissions: [...admissions].reverse(),
    descriptors: [...descriptors].reverse(),
    admissionsRoot: "admissions",
  });
  assert.deepEqual(second.mappings, first.mappings);
});

test("throws UNMAPPED_PARITY_ID when a parity entry has no materialization descriptor", () => {
  const { parity, descriptors, admissions } = buildFixture();
  const adapterIndex = descriptors.findIndex((descriptor) => descriptor.packageId === "cipherpol-1/adapter/cp1");
  const adapter = descriptors[adapterIndex];
  assert.ok(adapter);
  const shrunkDescriptors = [...descriptors];
  shrunkDescriptors[adapterIndex] = { ...adapter, parityIds: adapter.parityIds.slice(0, -1) };

  const error = captureError(() => composeClosureManifest({
    parity,
    admissions,
    descriptors: shrunkDescriptors,
    admissionsRoot: "admissions",
  }));
  assert.equal(error.code, "UNMAPPED_PARITY_ID");
});

test("throws UNKNOWN_PACKAGE_REFERENCE when a descriptor's package has no admission envelope", () => {
  const { parity, descriptors, admissions } = buildFixture();
  const withoutAdapterAdmission = admissions.filter((admission) => admission.packageRecord.id !== "cipherpol-1/adapter/cp1");

  const error = captureError(() => composeClosureManifest({
    parity,
    admissions: withoutAdapterAdmission,
    descriptors,
    admissionsRoot: "admissions",
  }));
  assert.equal(error.code, "UNKNOWN_PACKAGE_REFERENCE");
});

test("throws DUPLICATE_MCP_CAPABILITY when two MCP entries declare the same registered tool name", () => {
  const { parity, descriptors, admissions } = buildFixture();
  const entries = [...parity.entries];
  const firstToolIndex = entries.findIndex((entry) => entry.id === "cipherpol-1/mcp-tool/tool-01");
  const secondToolIndex = entries.findIndex((entry) => entry.id === "cipherpol-1/mcp-tool/tool-02");
  const firstTool = entries[firstToolIndex];
  const secondTool = entries[secondToolIndex];
  assert.ok(firstTool);
  assert.ok(secondTool);
  entries[secondToolIndex] = { ...secondTool, mcpCapabilities: [...firstTool.mcpCapabilities] };

  const error = captureError(() => composeClosureManifest({
    parity: { ...parity, entries },
    admissions,
    descriptors,
    admissionsRoot: "admissions",
  }));
  assert.equal(error.code, "DUPLICATE_MCP_CAPABILITY");
});

function buildRegistryFixture(): { closure: ClosureManifest; admissions: PackageAdmissionEnvelope[] } {
  const { parity, descriptors, admissions } = buildFixture();
  const closure = composeClosureManifest({ parity, admissions, descriptors, admissionsRoot: "admissions" });
  return { closure, admissions };
}

test("composes a registry index with sorted packages and empty capability packs and playbooks", () => {
  const { closure, admissions } = buildRegistryFixture();
  const registryIndex = composeClosureRegistry({ admissions, closure });

  assert.equal(registryIndex.schemaVersion, "cipherpol.registry/v1");
  assert.deepEqual(registryIndex.capabilityPacks, []);
  assert.deepEqual(registryIndex.playbooks, []);
  assert.equal(registryIndex.packages.length, admissions.length);
  const ids = registryIndex.packages.map((packageRecord) => packageRecord.id);
  const sortedIds = [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  assert.deepEqual(ids, sortedIds);
});

test("throws UNMAPPED_REGISTRY_PACKAGE when an admitted package has no closure mapping", () => {
  const { closure, admissions } = buildRegistryFixture();
  const extraAdmission = buildAdmission(buildPackageRecord("cipherpol-aegis/skill/orphan", "skill"));

  const error = captureError(() => composeClosureRegistry({
    admissions: [...admissions, extraAdmission],
    closure,
  }));
  assert.equal(error.code, "UNMAPPED_REGISTRY_PACKAGE");
});

test("throws DUPLICATE_PACKAGE_ID when the admitted set repeats a package ID", () => {
  const { closure, admissions } = buildRegistryFixture();

  const error = captureError(() => composeClosureRegistry({
    admissions: [...admissions, admissions[0]!],
    closure,
  }));
  assert.equal(error.code, "DUPLICATE_PACKAGE_ID");
});

function buildSignedFixture(keyPurpose: "fixture" | "production" = "fixture") {
  const { closure, admissions } = buildRegistryFixture();
  const registryIndex = composeClosureRegistry({ admissions, closure });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const envelope = signRegistryEnvelope(registryIndex, closure, {
    keyId: "registry-key-1",
    keyPurpose,
    privateKey,
  });
  return { registryIndex, closure, privateKey, publicKey, envelope };
}

test("signs and verifies a registry envelope over canonical JSON minus the signature", () => {
  const { envelope, publicKey } = buildSignedFixture("production");
  const verified = verifyRegistryEnvelope({
    envelope,
    trustedKeyId: "registry-key-1",
    trustedKeyPurpose: "production",
    publicKey,
    allowFixtureKeys: false,
  });
  assert.deepEqual(verified, envelope);
});

test("re-signing identical inputs with the same key produces byte-identical envelopes", () => {
  const { registryIndex, closure } = buildSignedFixture("production");
  const { privateKey } = generateKeyPairSync("ed25519");
  const first = signRegistryEnvelope(registryIndex, closure, { keyId: "registry-key-1", keyPurpose: "production", privateKey });
  const second = signRegistryEnvelope(registryIndex, closure, { keyId: "registry-key-1", keyPurpose: "production", privateKey });
  assert.deepEqual(first, second);
});

test("rejects a fixture-purpose registry key unless explicitly allowed", () => {
  const { envelope, publicKey } = buildSignedFixture("fixture");
  const error = captureError(() => verifyRegistryEnvelope({
    envelope,
    trustedKeyId: "registry-key-1",
    trustedKeyPurpose: "fixture",
    publicKey,
    allowFixtureKeys: false,
  }));
  assert.equal(error.code, "UNTRUSTED_KEY");

  const verified = verifyRegistryEnvelope({
    envelope,
    trustedKeyId: "registry-key-1",
    trustedKeyPurpose: "fixture",
    publicKey,
    allowFixtureKeys: true,
  });
  assert.deepEqual(verified, envelope);
});

test("rejects an untrusted key ID", () => {
  const { envelope, publicKey } = buildSignedFixture("production");
  const error = captureError(() => verifyRegistryEnvelope({
    envelope,
    trustedKeyId: "some-other-key",
    trustedKeyPurpose: "production",
    publicKey,
    allowFixtureKeys: false,
  }));
  assert.equal(error.code, "UNTRUSTED_KEY");
});

test("rejects a wrong public key", () => {
  const { envelope } = buildSignedFixture("production");
  const { publicKey: wrongPublicKey } = generateKeyPairSync("ed25519");
  const error = captureError(() => verifyRegistryEnvelope({
    envelope,
    trustedKeyId: "registry-key-1",
    trustedKeyPurpose: "production",
    publicKey: wrongPublicKey,
    allowFixtureKeys: false,
  }));
  assert.equal(error.code, "SIGNATURE_INVALID");
});

test("rejects a tampered registry package after signing", () => {
  const { envelope, publicKey } = buildSignedFixture("production");
  const tampered = {
    ...envelope,
    registryIndex: {
      ...envelope.registryIndex,
      packages: envelope.registryIndex.packages.map((packageRecord, index) => (
        index === 0 ? { ...packageRecord, owner: "attacker-owned" } : packageRecord
      )),
    },
  };
  const error = captureError(() => verifyRegistryEnvelope({
    envelope: tampered,
    trustedKeyId: "registry-key-1",
    trustedKeyPurpose: "production",
    publicKey,
    allowFixtureKeys: false,
  }));
  assert.equal(error.code, "SIGNATURE_INVALID");
});

test("rejects a tampered closure mapping after signing", () => {
  const { envelope, publicKey } = buildSignedFixture("production");
  const targetIndex = envelope.closureManifest.mappings.findIndex(
    (mapping) => mapping.parityId === "cipherpol-aegis/skill/foo",
  );
  const tampered = {
    ...envelope,
    closureManifest: {
      ...envelope.closureManifest,
      mappings: envelope.closureManifest.mappings.map((mapping, index) => (
        index === targetIndex ? { ...mapping, admissionPath: "admissions/attacker/injected.json" } : mapping
      )),
    },
  };
  const error = captureError(() => verifyRegistryEnvelope({
    envelope: tampered,
    trustedKeyId: "registry-key-1",
    trustedKeyPurpose: "production",
    publicKey,
    allowFixtureKeys: false,
  }));
  assert.equal(error.code, "SIGNATURE_INVALID");
});

test("rejects a keyId rewritten to an untrusted value even though the envelope re-validates", () => {
  const { envelope, publicKey } = buildSignedFixture("production");
  const rewritten = { ...envelope, keyId: "registry-key-2" };
  const error = captureError(() => verifyRegistryEnvelope({
    envelope: rewritten,
    trustedKeyId: "registry-key-2",
    trustedKeyPurpose: "production",
    publicKey,
    allowFixtureKeys: false,
  }));
  assert.equal(error.code, "SIGNATURE_INVALID");
});

test("rejects a keyPurpose rewritten to an untrusted value even though the envelope re-validates", () => {
  const { envelope, publicKey } = buildSignedFixture("production");
  const rewritten: typeof envelope = { ...envelope, keyPurpose: "fixture" };
  const error = captureError(() => verifyRegistryEnvelope({
    envelope: rewritten,
    trustedKeyId: "registry-key-1",
    trustedKeyPurpose: "fixture",
    publicKey,
    allowFixtureKeys: true,
  }));
  assert.equal(error.code, "SIGNATURE_INVALID");
});

test("rejects signing a registry index whose package does not match the closure's admission record", () => {
  const { parity, descriptors, admissions } = buildFixture();
  const closure = composeClosureManifest({ parity, admissions, descriptors, admissionsRoot: "admissions" });
  const registryIndex = composeClosureRegistry({ admissions, closure });
  const mismatchedRegistryIndex: RegistryIndex = {
    ...registryIndex,
    packages: registryIndex.packages.map((packageRecord) => (
      packageRecord.id === "cipherpol-aegis/skill/foo"
        ? { ...packageRecord, version: "9.9.9", digest: fakeDigest("mismatched") }
        : packageRecord
    )),
  };
  const { privateKey } = generateKeyPairSync("ed25519");

  const error = captureError(() => signRegistryEnvelope(mismatchedRegistryIndex, closure, {
    keyId: "registry-key-1",
    keyPurpose: "production",
    privateKey,
  }));
  assert.equal(error.code, "ENVELOPE_INVALID");
});
