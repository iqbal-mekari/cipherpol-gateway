import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { KeyObject } from "node:crypto";
import { verifyAdmission, verifyRegistryEnvelope } from "@cipherpol/admission";
import {
  canonicalJson,
  cipherpolManifestSchema, registryIndexSchema,
  type CipherpolManifest, type PackageRecord, type RegistryIndex,
} from "@cipherpol/contracts";
import { parse } from "yaml";
import { CipherpolError } from "./errors.js";

async function jsonDocument(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (cause) {
    throw new CipherpolError("INVALID_REGISTRY", `Cannot load ${path}`, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

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

export interface SignedRegistryTrust {
  readonly keyId: string;
  readonly keyPurpose: "fixture" | "production";
  readonly publicKey: KeyObject;
  readonly allowFixtureKeys: boolean;
}

/**
 * Loads and verifies a signed closure registry: the aggregate `registry-envelope.json`
 * signature, then every closure-referenced admission envelope at its documented
 * `admissionPath`, requiring each package's registry record to equal the record bound
 * inside its own verified admission envelope. When `verifyArtifacts` is set, each
 * package's materialized artifact (`registryRecord.artifactPath`, already root-relative
 * and `artifacts/`-prefixed by `materializeClosure`) is re-verified against the admitted
 * digest and declared file modes. Reuses `@cipherpol/admission`'s signing/verification
 * primitives exclusively; never reimplements signature or digest checks. Leaves
 * `loadRegistry` untouched.
 */
export async function loadSignedRegistry(
  root: string,
  trust: SignedRegistryTrust,
  options: { readonly verifyArtifacts?: boolean } = {},
): Promise<{ root: string; index: RegistryIndex }> {
  const envelopePath = join(root, "registry-envelope.json");
  const envelope = verifyRegistryEnvelope({
    envelope: await jsonDocument(envelopePath),
    trustedKeyId: trust.keyId,
    trustedKeyPurpose: trust.keyPurpose,
    publicKey: trust.publicKey,
    allowFixtureKeys: trust.allowFixtureKeys,
  });

  const packagesById = new Map<string, PackageRecord>(
    envelope.registryIndex.packages.map((record) => [record.id, record]),
  );
  const admissionPathByPackageId = new Map<string, string>();
  for (const mapping of envelope.closureManifest.mappings) {
    if (!admissionPathByPackageId.has(mapping.packageId)) {
      admissionPathByPackageId.set(mapping.packageId, mapping.admissionPath);
    }
  }

  for (const [packageId, admissionPath] of admissionPathByPackageId) {
    const registryRecord = packagesById.get(packageId);
    if (registryRecord === undefined) {
      throw new CipherpolError(
        "INVALID_REGISTRY",
        `Closure references a package absent from the registry index: ${packageId}`,
        { packageId },
      );
    }

    const admission = await jsonDocument(join(root, admissionPath));
    const verification = await verifyAdmission(admission, {
      trustedKeyId: trust.keyId,
      trustedPublicKey: trust.publicKey,
      allowFixtureKeys: trust.allowFixtureKeys,
      ...(options.verifyArtifacts === true
        ? { artifactRoot: join(root, registryRecord.artifactPath) }
        : {}),
    });

    if (canonicalJson(verification.packageRecord) !== canonicalJson(registryRecord)) {
      throw new CipherpolError(
        "ARTIFACT_MISMATCH",
        `Package record for ${packageId} does not match its verified admission envelope`,
        { packageId },
      );
    }
  }

  return { root, index: envelope.registryIndex };
}
