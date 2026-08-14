import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ClosureManifest, ParityEntryV2, ParityManifestV2, RegistryIndex } from "@cipherpol/contracts";
import {
  admitPackage,
  type AdmissionGateInputs,
  CipherpolAdmissionError,
  composeClosureManifest,
  composeClosureRegistry,
  type ImportedArtifactDescriptor,
  type PackageAdmissionInput,
  SOFTWARE_DEV_AGENTIC_BASELINE,
  signRegistryEnvelope,
} from "@cipherpol/admission";
import { CipherpolError, loadSignedRegistry, type SignedRegistryTrust } from "../src/index.js";

const SOURCE_REVISION = "a8afa8dd0848833b72ef536e1258d5c27bb8e3fc";
const MCP_TOOL_COUNT = 17;
const PACKAGE_ID = "cipherpol-1/adapter/cp1";
const PACKAGE_VERSION = "2.0.0";
const KEY_ID = "cipherpol-stage2-fixture-key";

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

function buildParityManifest(): { parity: ParityManifestV2; mcpEntryIds: string[] } {
  const mcpEntries: ParityEntryV2[] = [];
  for (let index = 1; index <= MCP_TOOL_COUNT; index += 1) {
    const id = `cipherpol-1/mcp-tool/tool-${String(index).padStart(2, "0")}`;
    mcpEntries.push({
      ...baseEntryFields(id),
      id,
      name: `Tool ${index}`,
      module: "cipherpol-1",
      moduleVersion: PACKAGE_VERSION,
      artifactType: "mcp-tool",
      mcpCapabilities: [`cp1_tool_${String(index).padStart(2, "0")}`],
      state: "equivalent",
    });
  }
  const parity: ParityManifestV2 = {
    schemaVersion: "cipherpol.parity/v2",
    sourceMarketplaceRevision: SOURCE_REVISION,
    baseline: SOFTWARE_DEV_AGENTIC_BASELINE,
    entries: mcpEntries,
  };
  return { parity, mcpEntryIds: mcpEntries.map((entry) => entry.id) };
}

function buildDescriptor(mcpEntryIds: readonly string[]): ImportedArtifactDescriptor {
  return {
    packageId: PACKAGE_ID,
    parityIds: [...mcpEntryIds],
    module: "cipherpol-1",
    moduleVersion: PACKAGE_VERSION,
    packageKind: "adapter",
    sourceKind: "cp1-adapter",
    sourcePaths: ["manifest.json"],
    targetRoot: "adapters/cp1",
  };
}

async function createGateInputs(context: TestContext): Promise<AdmissionGateInputs> {
  const gateRoot = await mkdtemp(join(tmpdir(), "cipherpol-resolver-gates-"));
  context.after(() => rm(gateRoot, { recursive: true, force: true }));
  const skillsDirectory = join(gateRoot, "skills");
  const agentsDirectory = join(gateRoot, "agents");
  await mkdir(join(skillsDirectory, "safe-skill"), { recursive: true });
  await mkdir(agentsDirectory, { recursive: true });
  await writeFile(join(skillsDirectory, "safe-skill", "SKILL.md"), "# Safe skill\n", "utf8");
  await writeFile(join(agentsDirectory, "safe-agent.md"), "# Safe agent\n", "utf8");
  return { packageSet: [{ id: PACKAGE_ID, dependencies: [] }], skillsDirectory, agentsDirectory };
}

interface SignedClosureFixture {
  readonly registryRoot: string;
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  readonly registryIndex: RegistryIndex;
  readonly closure: ClosureManifest;
  readonly registryEnvelopePath: string;
  readonly admissionAbsolutePath: string;
  readonly artifactFilePath: string;
  readonly trust: SignedRegistryTrust;
}

async function buildSignedClosureFixture(
  context: TestContext,
  options: { readonly keyPurpose?: "fixture" | "production" } = {},
): Promise<SignedClosureFixture> {
  const keyPurpose = options.keyPurpose ?? "fixture";
  const manifestContent = "# CP1 adapter manifest\n";

  const artifactSourceRoot = await mkdtemp(join(tmpdir(), "cipherpol-resolver-artifact-"));
  context.after(() => rm(artifactSourceRoot, { recursive: true, force: true }));
  await writeFile(join(artifactSourceRoot, "manifest.json"), manifestContent, "utf8");

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");

  const input: PackageAdmissionInput = {
    id: PACKAGE_ID,
    kind: "adapter",
    version: PACKAGE_VERSION,
    owner: "test-owner",
    sourceRevision: SOURCE_REVISION,
    artifactPath: `artifacts/${PACKAGE_ID}/${PACKAGE_VERSION}`,
    compatibility: { claudeCode: ">=1.0.0", capabilities: [] },
    dependencies: [],
    files: [{ source: "manifest.json", target: "manifest.json" }],
    provenance: {
      sourceRepository: "https://example.test/software-dev-agentic.git",
      sourceRevision: SOURCE_REVISION,
      sourcePaths: ["manifest.json"],
    },
    keyId: KEY_ID,
    keyPurpose,
    signingKey: privateKey,
  };

  const admissionEnvelope = await admitPackage(input, artifactSourceRoot, await createGateInputs(context));

  const { parity, mcpEntryIds } = buildParityManifest();
  const closure = composeClosureManifest({
    parity,
    admissions: [admissionEnvelope],
    descriptors: [buildDescriptor(mcpEntryIds)],
    admissionsRoot: "admissions",
  });
  const registryIndex = composeClosureRegistry({ admissions: [admissionEnvelope], closure });
  const envelope = signRegistryEnvelope(registryIndex, closure, { keyId: KEY_ID, keyPurpose, privateKey });

  const registryRoot = await mkdtemp(join(tmpdir(), "cipherpol-resolver-registry-"));
  context.after(() => rm(registryRoot, { recursive: true, force: true }));

  const registryEnvelopePath = join(registryRoot, "registry-envelope.json");
  await writeFile(registryEnvelopePath, JSON.stringify(envelope), "utf8");

  const admissionAbsolutePath = join(registryRoot, "admissions", "cipherpol-1", "adapter", "cp1.json");
  await mkdir(dirname(admissionAbsolutePath), { recursive: true });
  await writeFile(admissionAbsolutePath, JSON.stringify(admissionEnvelope), "utf8");

  const artifactFilePath = join(
    registryRoot, "artifacts", "cipherpol-1", "adapter", "cp1", PACKAGE_VERSION, "manifest.json",
  );
  await mkdir(dirname(artifactFilePath), { recursive: true });
  await writeFile(artifactFilePath, manifestContent, "utf8");

  const trust: SignedRegistryTrust = {
    keyId: KEY_ID,
    keyPurpose,
    publicKey,
    allowFixtureKeys: keyPurpose === "fixture",
  };

  return {
    registryRoot,
    publicKey,
    privateKey,
    registryIndex,
    closure,
    registryEnvelopePath,
    admissionAbsolutePath,
    artifactFilePath,
    trust,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), "utf8");
}

async function captureError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("Expected an error");
}

test("loads a valid fixture-signed registry", async (context) => {
  const fixture = await buildSignedClosureFixture(context);
  const result = await loadSignedRegistry(fixture.registryRoot, fixture.trust);
  assert.equal(result.root, fixture.registryRoot);
  assert.deepEqual(result.index, fixture.registryIndex);
});

test("rejects a fixture key unless explicitly allowed", async (context) => {
  const fixture = await buildSignedClosureFixture(context, { keyPurpose: "fixture" });
  const trust: SignedRegistryTrust = { ...fixture.trust, allowFixtureKeys: false };

  const error = await captureError(() => loadSignedRegistry(fixture.registryRoot, trust));
  assert.ok(error instanceof CipherpolAdmissionError);
  assert.equal(error.code, "UNTRUSTED_KEY");
});

test("rejects a tampered aggregate registry signature", async (context) => {
  const fixture = await buildSignedClosureFixture(context);
  const rawEnvelope = JSON.parse(await readFile(fixture.registryEnvelopePath, "utf8"));
  rawEnvelope.registryIndex.packages[0].owner = "attacker-owner";
  await writeJson(fixture.registryEnvelopePath, rawEnvelope);

  const error = await captureError(() => loadSignedRegistry(fixture.registryRoot, fixture.trust));
  assert.ok(error instanceof CipherpolAdmissionError);
  assert.equal(error.code, "SIGNATURE_INVALID");
});

test("rejects a missing per-package admission envelope", async (context) => {
  const fixture = await buildSignedClosureFixture(context);
  await rm(fixture.admissionAbsolutePath, { force: true });

  const error = await captureError(() => loadSignedRegistry(fixture.registryRoot, fixture.trust));
  assert.ok(error instanceof CipherpolError);
  assert.equal(error.code, "INVALID_REGISTRY");
});

test("rejects a tampered per-package admission envelope", async (context) => {
  const fixture = await buildSignedClosureFixture(context);
  const rawAdmission = JSON.parse(await readFile(fixture.admissionAbsolutePath, "utf8"));
  rawAdmission.packageRecord.owner = "attacker-owner";
  await writeJson(fixture.admissionAbsolutePath, rawAdmission);

  const error = await captureError(() => loadSignedRegistry(fixture.registryRoot, fixture.trust));
  assert.ok(error instanceof CipherpolAdmissionError);
  assert.equal(error.code, "SIGNATURE_INVALID");
});

test(
  "rejects a package-record mismatch between the aggregate registry and its verified admission envelope",
  async (context) => {
    const fixture = await buildSignedClosureFixture(context);
    const tamperedRegistryIndex: RegistryIndex = {
      ...fixture.registryIndex,
      packages: fixture.registryIndex.packages.map((record) => (
        record.id === PACKAGE_ID ? { ...record, owner: "attacker-owner" } : record
      )),
    };
    const tamperedEnvelope = signRegistryEnvelope(tamperedRegistryIndex, fixture.closure, {
      keyId: KEY_ID,
      keyPurpose: "fixture",
      privateKey: fixture.privateKey,
    });
    await writeJson(fixture.registryEnvelopePath, tamperedEnvelope);

    const error = await captureError(() => loadSignedRegistry(fixture.registryRoot, fixture.trust));
    assert.ok(error instanceof CipherpolError);
    assert.equal(error.code, "ARTIFACT_MISMATCH");
  },
);

test("rejects an artifact tamper when verifyArtifacts is true", async (context) => {
  const fixture = await buildSignedClosureFixture(context);
  await writeFile(fixture.artifactFilePath, "# tampered manifest\n", "utf8");

  const error = await captureError(
    () => loadSignedRegistry(fixture.registryRoot, fixture.trust, { verifyArtifacts: true }),
  );
  assert.ok(error instanceof CipherpolAdmissionError);
  assert.equal(error.code, "DIGEST_MISMATCH");
});

test("rejects a wrong trusted key ID", async (context) => {
  const fixture = await buildSignedClosureFixture(context);
  const trust: SignedRegistryTrust = { ...fixture.trust, keyId: "wrong-key-id" };

  const error = await captureError(() => loadSignedRegistry(fixture.registryRoot, trust));
  assert.ok(error instanceof CipherpolAdmissionError);
  assert.equal(error.code, "UNTRUSTED_KEY");
});

test("rejects a wrong trusted public key", async (context) => {
  const fixture = await buildSignedClosureFixture(context);
  const { publicKey: wrongPublicKey } = generateKeyPairSync("ed25519");
  const trust: SignedRegistryTrust = { ...fixture.trust, publicKey: wrongPublicKey };

  const error = await captureError(() => loadSignedRegistry(fixture.registryRoot, trust));
  assert.ok(error instanceof CipherpolAdmissionError);
  assert.equal(error.code, "SIGNATURE_INVALID");
});
