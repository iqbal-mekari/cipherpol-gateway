import { posix } from "node:path";
import {
  canonicalArtifactDigest,
  canonicalJson,
  closureManifestSchema,
  registryIndexSchema,
  type ClosureManifest,
  type ClosureMapping,
  type ParityManifestV2,
  type RegistryIndex,
} from "@cipherpol/contracts";
import { z } from "zod";
import type { PackageAdmissionEnvelope } from "./admission.js";
import { type AdmissionErrorCode, CipherpolAdmissionError } from "./errors.js";
import type { ImportedArtifactDescriptor } from "./importer.js";

/**
 * A packageId is only ever used to derive a filesystem path once every "/"-delimited
 * segment starts with an alphanumeric character; this rules out "." and ".." segments
 * by construction and mirrors the encoding used for materialized artifact paths.
 */
const STABLE_PACKAGE_ID = /^[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/;

const PARITY_MANIFEST_DIGEST_SUBJECT = "parity-manifest.json";

function parseOrThrow<Output, Input>(
  schema: z.ZodType<Output, z.ZodTypeDef, Input>,
  value: unknown,
  subject: string,
  code: AdmissionErrorCode,
): Output {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new CipherpolAdmissionError(code, `Invalid ${subject}`, {
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return result.data;
}

/**
 * Computes a canonical digest of a parity manifest by framing its canonical JSON
 * through the same {@link canonicalArtifactDigest} primitive used for admitted
 * artifact bytes. Any later verifier (resolver, CLI) can independently recompute
 * this digest from a raw parity manifest to prove it matches a signed closure.
 */
export function canonicalParityManifestDigest(parity: ParityManifestV2): string {
  return canonicalArtifactDigest([
    { path: PARITY_MANIFEST_DIGEST_SUBJECT, bytes: Buffer.from(canonicalJson(parity), "utf8") },
  ]);
}

function assertParityManifestShape(parity: ParityManifestV2): void {
  if (parity === null || typeof parity !== "object") {
    throw new CipherpolAdmissionError("CLOSURE_INVALID", "Parity manifest must be an object");
  }
  if (parity.schemaVersion !== "cipherpol.parity/v2") {
    throw new CipherpolAdmissionError(
      "CLOSURE_INVALID",
      `Unsupported parity manifest schema version: ${String(parity.schemaVersion)}`,
      { schemaVersion: parity.schemaVersion },
    );
  }
  if (!Array.isArray(parity.entries) || parity.entries.length === 0) {
    throw new CipherpolAdmissionError("CLOSURE_INVALID", "Parity manifest must declare at least one entry");
  }
}

function admissionEnvelopePath(admissionsRoot: string, packageId: string): string {
  if (!STABLE_PACKAGE_ID.test(packageId)) {
    throw new CipherpolAdmissionError(
      "INVALID_REFERENCE",
      `Package ID is not a stable path-safe ID: ${packageId}`,
      { packageId },
    );
  }
  const idPath = packageId.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return posix.join(admissionsRoot, `${idPath}.json`);
}

/**
 * Composes the closure manifest binding every non-MCP parity entry to its admitted
 * package, and every MCP-tool parity entry to the shared cp1 adapter package under
 * its exact registered tool capability name. The authoritative parity manifest's
 * entry-ID set must exactly equal the union of descriptor `parityIds`; the count of
 * parity entries is never assumed, only measured from the supplied inputs.
 */
export function composeClosureManifest(args: {
  readonly parity: ParityManifestV2;
  readonly admissions: readonly PackageAdmissionEnvelope[];
  readonly descriptors: readonly ImportedArtifactDescriptor[];
  readonly admissionsRoot: string;
}): ClosureManifest {
  const { parity, admissions, descriptors, admissionsRoot } = args;
  assertParityManifestShape(parity);
  if (
    admissionsRoot.length === 0
    || admissionsRoot.startsWith("/")
    || admissionsRoot.includes("\\")
    || admissionsRoot.split("/").includes("..")
  ) {
    throw new CipherpolAdmissionError(
      "INVALID_REFERENCE",
      `admissions root must be a relative, traversal-free path: ${admissionsRoot}`,
      { admissionsRoot },
    );
  }

  const descriptorByParityId = new Map<string, ImportedArtifactDescriptor>();
  for (const descriptor of descriptors) {
    for (const parityId of descriptor.parityIds) {
      if (descriptorByParityId.has(parityId)) {
        throw new CipherpolAdmissionError(
          "INVALID_REFERENCE",
          `Parity ID is claimed by more than one materialization descriptor: ${parityId}`,
          { parityId },
        );
      }
      descriptorByParityId.set(parityId, descriptor);
    }
  }

  const parityEntryIds = new Set(parity.entries.map((entry) => entry.id));
  for (const parityId of descriptorByParityId.keys()) {
    if (!parityEntryIds.has(parityId)) {
      throw new CipherpolAdmissionError(
        "INVALID_REFERENCE",
        `Materialization descriptor references a parity ID absent from the authoritative parity manifest: ${parityId}`,
        { parityId },
      );
    }
  }

  const admissionsByPackageId = new Map<string, PackageAdmissionEnvelope>();
  for (const admission of admissions) {
    const packageId = admission.packageRecord.id;
    if (admissionsByPackageId.has(packageId)) {
      throw new CipherpolAdmissionError(
        "DUPLICATE_PACKAGE_ID",
        `Duplicate admission envelope for package: ${packageId}`,
        { packageId },
      );
    }
    admissionsByPackageId.set(packageId, admission);
  }

  const mappings: ClosureMapping[] = [];
  const mcpCapabilities = new Set<string>();

  for (const entry of parity.entries) {
    const descriptor = descriptorByParityId.get(entry.id);
    if (descriptor === undefined) {
      throw new CipherpolAdmissionError(
        "UNMAPPED_PARITY_ID",
        `Parity entry has no materialization descriptor: ${entry.id}`,
        { parityId: entry.id },
      );
    }

    const admission = admissionsByPackageId.get(descriptor.packageId);
    if (admission === undefined) {
      throw new CipherpolAdmissionError(
        "UNKNOWN_PACKAGE_REFERENCE",
        `Materialization descriptor references a package with no admission envelope: ${descriptor.packageId}`,
        { parityId: entry.id, packageId: descriptor.packageId },
      );
    }

    const admissionPath = admissionEnvelopePath(admissionsRoot, admission.packageRecord.id);

    if (entry.artifactType === "mcp-tool") {
      const capability = entry.mcpCapabilities.length === 1 ? entry.mcpCapabilities[0] : undefined;
      if (capability === undefined) {
        throw new CipherpolAdmissionError(
          "INVALID_REFERENCE",
          `MCP parity entry must declare exactly one registered tool capability: ${entry.id}`,
          { parityId: entry.id, mcpCapabilities: entry.mcpCapabilities },
        );
      }
      if (mcpCapabilities.has(capability)) {
        throw new CipherpolAdmissionError(
          "DUPLICATE_MCP_CAPABILITY",
          `Duplicate MCP capability across closure mappings: ${capability}`,
          { capability, parityId: entry.id },
        );
      }
      mcpCapabilities.add(capability);

      mappings.push({
        parityId: entry.id,
        mappingType: "mcp-tool",
        packageId: admission.packageRecord.id,
        packageVersion: admission.packageRecord.version,
        packageDigest: admission.packageRecord.digest,
        admissionPath,
        capability,
      });
    } else {
      mappings.push({
        parityId: entry.id,
        mappingType: "package",
        packageId: admission.packageRecord.id,
        packageVersion: admission.packageRecord.version,
        packageDigest: admission.packageRecord.digest,
        admissionPath,
      });
    }
  }

  mappings.sort((left, right) => (left.parityId < right.parityId ? -1 : left.parityId > right.parityId ? 1 : 0));

  const manifest: ClosureManifest = {
    schemaVersion: "cipherpol.closure/v1",
    sourceRevision: parity.sourceMarketplaceRevision,
    paritySchemaVersion: "cipherpol.parity/v2",
    parityManifestDigest: canonicalParityManifestDigest(parity),
    mappings,
  };

  return parseOrThrow(closureManifestSchema, manifest, "composed closure manifest", "CLOSURE_INVALID");
}

/**
 * Composes the registry index for a signed closure: one verified package record per
 * admitted package, sorted by ID, with empty `capabilityPacks`/`playbooks`. Every
 * admitted package must have a closure mapping, and every package ID must be unique
 * across the admitted set.
 */
export function composeClosureRegistry(args: {
  readonly admissions: readonly PackageAdmissionEnvelope[];
  readonly closure: ClosureManifest;
}): RegistryIndex {
  const { admissions, closure } = args;

  const mappedPackageIds = new Set(closure.mappings.map((mapping) => mapping.packageId));
  const recordsById = new Map<string, PackageAdmissionEnvelope["packageRecord"]>();

  for (const admission of admissions) {
    const record = admission.packageRecord;
    if (recordsById.has(record.id)) {
      throw new CipherpolAdmissionError(
        "DUPLICATE_PACKAGE_ID",
        `Duplicate or conflicting admission record for package: ${record.id}`,
        { packageId: record.id },
      );
    }
    if (!mappedPackageIds.has(record.id)) {
      throw new CipherpolAdmissionError(
        "UNMAPPED_REGISTRY_PACKAGE",
        `Admitted package has no closure mapping: ${record.id}`,
        { packageId: record.id },
      );
    }
    recordsById.set(record.id, record);
  }

  for (const packageId of mappedPackageIds) {
    if (!recordsById.has(packageId)) {
      throw new CipherpolAdmissionError(
        "UNKNOWN_PACKAGE_REFERENCE",
        `Closure mapping references a package with no admission envelope: ${packageId}`,
        { packageId },
      );
    }
  }

  const packages = [...recordsById.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const registryIndex: RegistryIndex = {
    schemaVersion: "cipherpol.registry/v1",
    packages,
    capabilityPacks: [],
    playbooks: [],
  };

  return parseOrThrow(registryIndexSchema, registryIndex, "composed registry index", "REGISTRY_INVALID");
}
