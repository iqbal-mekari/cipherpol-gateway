import { artifactModeSchema } from "@cipherpol/contracts";
import type { PackageAdmissionInput } from "./admission.js";
import { assertPackageGateTargets } from "./admission.js";
import { CipherpolAdmissionError } from "./errors.js";
import { validateImportPolicyPackageDependencies } from "./import-policy.js";
import type { SoftwareDevAgenticImportPolicy } from "./import-policy.js";
import type { SoftwareDevAgenticImportResult } from "./importer.js";
import type { MaterializedClosure, MaterializedPackage } from "./materialize.js";

/**
 * A package-record-shaped admission input derived only from a materialized package,
 * its materialization descriptor, and the checked-in import policy. Signing key, key
 * ID, and key purpose are supplied later by the batch admission caller.
 */
export interface GeneratedPackageInput {
  readonly input: Omit<PackageAdmissionInput, "signingKey" | "keyId" | "keyPurpose">;
  readonly artifactRoot: string;
}


function generateOne(
  materializedPackage: MaterializedPackage,
  imported: SoftwareDevAgenticImportResult,
  policy: SoftwareDevAgenticImportPolicy,
  sourceRepository: string,
): GeneratedPackageInput {
  const descriptor = materializedPackage.descriptor;
  const modulePolicy = policy.modules[descriptor.module];
  if (modulePolicy === undefined) {
    throw new CipherpolAdmissionError(
      "INVALID_ADMISSION",
      `Import policy has no module entry for ${descriptor.module}`,
      { packageId: descriptor.packageId, module: descriptor.module },
    );
  }
  if (modulePolicy.packageVersion !== "module-version") {
    throw new CipherpolAdmissionError(
      "INVALID_ADMISSION",
      `Module policy declares an unsupported package-version mode for ${descriptor.module}`,
      {
        packageId: descriptor.packageId,
        module: descriptor.module,
        packageVersion: modulePolicy.packageVersion,
        reason: "module-version-mismatch",
      },
    );
  }

  const pinnedModuleVersion = imported.moduleVersions[descriptor.module];
  if (pinnedModuleVersion !== descriptor.moduleVersion) {
    throw new CipherpolAdmissionError(
      "PROVENANCE_MISMATCH",
      "Descriptor module version does not match the imported module pin",
      {
        packageId: descriptor.packageId,
        module: descriptor.module,
        descriptorModuleVersion: descriptor.moduleVersion,
        importedModuleVersion: pinnedModuleVersion,
        reason: "module-version-mismatch",
      },
    );
  }

  assertPackageGateTargets(descriptor.packageId, descriptor.packageKind, materializedPackage.files);

  const files = materializedPackage.files.map((file) => {
    const mode = artifactModeSchema.safeParse(file.mode);
    if (!mode.success) {
      throw new CipherpolAdmissionError(
        "INVALID_ADMISSION",
        `Materialized file has an invalid mode: ${String(file.mode)}`,
        { packageId: descriptor.packageId, source: file.source, mode: file.mode },
      );
    }
    return { source: file.source, target: file.target, mode: mode.data };
  });

  const dependencies = [...(policy.packageDependencies[descriptor.packageId] ?? [])];

  const input: Omit<PackageAdmissionInput, "signingKey" | "keyId" | "keyPurpose"> = {
    id: descriptor.packageId,
    kind: descriptor.packageKind,
    version: descriptor.moduleVersion,
    owner: modulePolicy.owner,
    sourceRevision: imported.sourceRevision,
    artifactPath: materializedPackage.artifactPath,
    compatibility: {
      claudeCode: modulePolicy.claudeCode,
      capabilities: [...modulePolicy.capabilities],
    },
    dependencies,
    files,
    provenance: {
      sourceRepository,
      sourceRevision: imported.sourceRevision,
      sourcePaths: [...descriptor.sourcePaths],
    },
  };

  return { input, artifactRoot: materializedPackage.artifactRoot };
}

/**
 * Derives one {@link GeneratedPackageInput} per materialized package. Compatibility,
 * owner, and capabilities come from the checked-in import policy per module; package
 * dependencies come only from `policy.packageDependencies`, never from parity
 * composition. Every dependency reference is validated against the complete generated
 * package-ID set before any input is returned.
 */
export function generatePackageInputs(args: {
  readonly imported: SoftwareDevAgenticImportResult;
  readonly materialized: MaterializedClosure;
  readonly policy: SoftwareDevAgenticImportPolicy;
  readonly sourceRepository: string;
}): readonly GeneratedPackageInput[] {
  const { imported, materialized, policy, sourceRepository } = args;

  const packageIds = materialized.packages.map((materializedPackage) => materializedPackage.descriptor.packageId);
  const uniquePackageIds = new Set(packageIds);
  if (uniquePackageIds.size !== packageIds.length) {
    throw new CipherpolAdmissionError(
      "DUPLICATE_PACKAGE_ID",
      "Materialized closure contains a duplicate package ID",
    );
  }
  validateImportPolicyPackageDependencies(policy, packageIds);

  const generated = materialized.packages.map((materializedPackage) => (
    generateOne(materializedPackage, imported, policy, sourceRepository)
  ));

  return [...generated].sort((left, right) => (
    left.input.id < right.input.id ? -1 : left.input.id > right.input.id ? 1 : 0
  ));
}
