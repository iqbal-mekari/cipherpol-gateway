import { randomBytes } from "node:crypto";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ControlPlaneTrustConfig } from "../../src/ingest.js";
import {
  admitPackage,
  type AdmissionGateInputs,
  composeClosureManifest,
  composeClosureRegistry,
  type ImportedArtifactDescriptor,
  type PackageAdmissionEnvelope,
  type PackageAdmissionInput,
  SOFTWARE_DEV_AGENTIC_BASELINE,
  signRegistryEnvelope,
} from "@cipherpol/admission";
import type {
  CapabilityPack, ClosureManifest, ParityEntryV2, ParityManifestV2, Playbook, RegistryEnvelope, RegistryIndex,
} from "@cipherpol/contracts";

const SOURCE_REVISION = "a8afa8dd0848833b72ef536e1258d5c27bb8e3fc";
const MCP_TOOL_COUNT = 17;
const KEY_ID = "cipherpol-control-plane-test-key";

/** A short, random, lowercase-hex suffix for building per-test-run-unique identifiers. */
export function uniqueSuffix(): string {
  return randomBytes(4).toString("hex");
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

function buildParityManifest(packageVersion: string): { parity: ParityManifestV2; mcpEntryIds: string[] } {
  const mcpEntries: ParityEntryV2[] = [];
  for (let index = 1; index <= MCP_TOOL_COUNT; index += 1) {
    const id = `cipherpol-1/mcp-tool/tool-${String(index).padStart(2, "0")}`;
    mcpEntries.push({
      ...baseEntryFields(id),
      id,
      name: `Tool ${index}`,
      module: "cipherpol-1",
      moduleVersion: packageVersion,
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

function buildDescriptor(packageId: string, packageVersion: string, mcpEntryIds: readonly string[]): ImportedArtifactDescriptor {
  return {
    packageId,
    parityIds: [...mcpEntryIds],
    module: "cipherpol-1",
    moduleVersion: packageVersion,
    packageKind: "adapter",
    sourceKind: "cp1-adapter",
    sourcePaths: ["manifest.json"],
    targetRoot: "adapters/cp1",
  };
}

async function createGateInputs(context: TestContext, packageId: string): Promise<AdmissionGateInputs> {
  const gateRoot = await mkdtemp(join(tmpdir(), "cipherpol-cp-gates-"));
  context.after(() => rm(gateRoot, { recursive: true, force: true }));
  const skillsDirectory = join(gateRoot, "skills");
  const agentsDirectory = join(gateRoot, "agents");
  await mkdir(join(skillsDirectory, "safe-skill"), { recursive: true });
  await mkdir(agentsDirectory, { recursive: true });
  await writeFile(join(skillsDirectory, "safe-skill", "SKILL.md"), "# Safe skill\n", "utf8");
  await writeFile(join(agentsDirectory, "safe-agent.md"), "# Safe agent\n", "utf8");
  return { packageSet: [{ id: packageId, dependencies: [] }], skillsDirectory, agentsDirectory };
}

export interface BuildSignedClosureOptions {
  readonly keyPurpose?: "fixture" | "production";
  /** Injected into the composed registry index before signing (default: empty). */
  readonly capabilityPacks?: readonly CapabilityPack[];
  readonly playbooks?: readonly Playbook[];
  /** Force a specific suffix (and thus packageId) instead of generating a fresh one. */
  readonly suffix?: string;
  /** Override the admitted package's owner, to build content that differs from another fixture reusing the same suffix. */
  readonly owner?: string;
}

export interface SignedClosureFixture {
  readonly suffix: string;
  readonly packageId: string;
  readonly packageVersion: string;
  readonly registryIndex: RegistryIndex;
  readonly closureManifest: ClosureManifest;
  readonly registryEnvelope: RegistryEnvelope;
  readonly admissionPath: string;
  readonly admissionEnvelopes: Record<string, PackageAdmissionEnvelope>;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly publicKeyPem: string;
  readonly keyId: string;
  readonly keyPurpose: "fixture" | "production";
}

/**
 * Builds a small, real, end-to-end signed Stage 2 closure: one admitted "adapter"
 * package backing exactly 17 MCP-tool closure mappings (the fixed count
 * `closureManifestSchema` requires), aggregated and signed with a freshly generated
 * Ed25519 key pair. Mirrors the fixture pattern in
 * `packages/admission/test/closure.test.ts` and
 * `packages/resolver/test/signed-registry.test.ts`. The package ID is namespaced
 * with a random per-call suffix so concurrent test runs never collide on the same
 * `packages`/`registry_snapshots` rows in the shared local Postgres instance.
 */
export async function buildSignedClosureFixture(
  context: TestContext,
  options: BuildSignedClosureOptions = {},
): Promise<SignedClosureFixture> {
  const keyPurpose = options.keyPurpose ?? "fixture";
  const suffix = options.suffix ?? uniqueSuffix();
  const packageId = `cipherpol-test-${suffix}/adapter/cp1`;
  const packageVersion = "2.0.0";
  const manifestContent = `# CP1 adapter manifest ${suffix}\n`;

  const artifactSourceRoot = await mkdtemp(join(tmpdir(), "cipherpol-cp-artifact-"));
  context.after(() => rm(artifactSourceRoot, { recursive: true, force: true }));
  await writeFile(join(artifactSourceRoot, "manifest.json"), manifestContent, "utf8");

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  const input: PackageAdmissionInput = {
    id: packageId,
    kind: "adapter",
    version: packageVersion,
    owner: options.owner ?? "control-plane-test",
    sourceRevision: SOURCE_REVISION,
    artifactPath: `artifacts/${packageId}/${packageVersion}`,
    compatibility: { claudeCode: ">=1.0.0", capabilities: [] },
    dependencies: [],
    files: [{ source: "manifest.json", target: "manifest.json" }],
    provenance: {
      sourceRepository: "https://example.test/control-plane-fixture.git",
      sourceRevision: SOURCE_REVISION,
      sourcePaths: ["manifest.json"],
    },
    keyId: KEY_ID,
    keyPurpose,
    signingKey: privateKey,
  };

  const admissionEnvelope = await admitPackage(input, artifactSourceRoot, await createGateInputs(context, packageId));

  const { parity, mcpEntryIds } = buildParityManifest(packageVersion);
  const closureManifest = composeClosureManifest({
    parity,
    admissions: [admissionEnvelope],
    descriptors: [buildDescriptor(packageId, packageVersion, mcpEntryIds)],
    admissionsRoot: "admissions",
  });
  const baseRegistryIndex = composeClosureRegistry({ admissions: [admissionEnvelope], closure: closureManifest });
  const registryIndex: RegistryIndex = {
    ...baseRegistryIndex,
    capabilityPacks: options.capabilityPacks ? [...options.capabilityPacks] : baseRegistryIndex.capabilityPacks,
    playbooks: options.playbooks ? [...options.playbooks] : baseRegistryIndex.playbooks,
  };
  const registryEnvelope = signRegistryEnvelope(registryIndex, closureManifest, { keyId: KEY_ID, keyPurpose, privateKey });
  const admissionPath = closureManifest.mappings[0]?.admissionPath;
  if (admissionPath === undefined) throw new Error("expected closure manifest to have at least one mapping");

  return {
    suffix,
    packageId,
    packageVersion,
    registryIndex,
    closureManifest,
    registryEnvelope,
    admissionPath,
    admissionEnvelopes: { [admissionPath]: admissionEnvelope },
    privateKey,
    publicKey,
    publicKeyPem,
    keyId: KEY_ID,
    keyPurpose,
  };
}

/**
 * Builds the server-pinned `ControlPlaneTrustConfig` a control-plane instance
 * would resolve at boot to trust exactly the key material a given fixture (or
 * the real committed fixture) was signed with. Never derived from request-body
 * content — mirrors how a real deployment pins trust from environment/config.
 */
export function trustConfigFromFixture(
  fixture: Pick<SignedClosureFixture, "keyId" | "publicKeyPem" | "keyPurpose">,
): ControlPlaneTrustConfig {
  return {
    trustedKeyId: fixture.keyId,
    trustedPublicKeyPem: fixture.publicKeyPem,
    trustedKeyPurpose: fixture.keyPurpose,
    allowFixtureKeys: true,
  };
}

/**
 * Deletes only the rows a test's own fixture(s) created: the channel's snapshot
 * row(s) and every package/capability-pack/playbook row for the given package IDs.
 * Never touches unrelated rows, so it is safe to run against a shared local
 * Postgres instance.
 */
export async function cleanupFixtureRows(
  client: SupabaseClient,
  args: { readonly channels?: readonly string[]; readonly packageIds?: readonly string[] },
): Promise<void> {
  for (const channel of args.channels ?? []) {
    await client.from("registry_snapshots").delete().eq("channel", channel);
  }
  for (const packageId of args.packageIds ?? []) {
    await client.from("packages").delete().eq("id", packageId);
    await client.from("capability_packs").delete().eq("id", packageId);
    await client.from("playbooks").delete().eq("id", packageId);
    await client.from("package_files").delete().eq("package_id", packageId);
  }
}
