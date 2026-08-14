import { readFile } from "node:fs/promises";
import { validRange } from "semver";
import { parseDocument } from "yaml";
import { z } from "zod";
import { CipherpolAdmissionError } from "./errors.js";
import type { ImportedArtifactDescriptor, SoftwareDevAgenticModule } from "./importer.js";

const SOFTWARE_DEV_AGENTIC_MODULES = [
  "cipherpol-aegis",
  "cipherpol-9",
  "cipherpol-1",
] as const satisfies readonly SoftwareDevAgenticModule[];

const stablePackageId = z.string().regex(
  /^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9._/-]*$/,
  "package ID must be a stable ID",
);

const moduleImportPolicySchema = z.object({
  owner: z.string().trim().min(1),
  packageVersion: z.literal("module-version"),
  claudeCode: z.string().trim().min(1).refine(
    (range) => validRange(range) !== null,
    "claudeCode must be a valid semantic-version range",
  ),
  capabilities: z.array(z.string().trim().min(1)).superRefine((capabilities, context) => {
    const seen = new Set<string>();
    for (const capability of capabilities) {
      if (seen.has(capability)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate capability: ${capability}` });
      }
      seen.add(capability);
    }
  }),
}).strict();

const modulesSchema = z.object({
  "cipherpol-aegis": moduleImportPolicySchema,
  "cipherpol-9": moduleImportPolicySchema,
  "cipherpol-1": moduleImportPolicySchema,
}).strict();

const importPolicySchema = z.object({
  schemaVersion: z.literal("cipherpol.import-policy/v1"),
  modules: modulesSchema,
  packageDependencies: z.record(stablePackageId, z.array(z.string().trim().min(1))),
}).strict();

export interface ModuleImportPolicy {
  readonly owner: string;
  readonly packageVersion: "module-version";
  readonly claudeCode: string;
  readonly capabilities: readonly string[];
}

export interface SoftwareDevAgenticImportPolicy {
  readonly schemaVersion: "cipherpol.import-policy/v1";
  readonly modules: Readonly<Record<SoftwareDevAgenticModule, ModuleImportPolicy>>;
  readonly packageDependencies: Readonly<Record<string, readonly string[]>>;
}

export interface PackageDependencyReference {
  readonly packageId: string;
  readonly range: string;
}

function invalidPolicy(message: string, details: Record<string, unknown> = {}): never {
  throw new CipherpolAdmissionError("INVALID_ADMISSION", message, details);
}

export function parsePackageDependencyReference(reference: string): PackageDependencyReference {
  const separator = reference.lastIndexOf("@");
  if (separator <= 0 || separator === reference.length - 1) {
    throw new CipherpolAdmissionError("INVALID_REFERENCE", "Package dependency must use stable-id@range", {
      reference,
    });
  }

  const packageId = reference.slice(0, separator);
  const range = reference.slice(separator + 1);
  if (!stablePackageId.safeParse(packageId).success || validRange(range) === null) {
    throw new CipherpolAdmissionError("INVALID_REFERENCE", "Package dependency must use a stable ID and semantic-version range", {
      reference,
    });
  }
  return { packageId, range };
}

function assertAcyclicPackageDependencies(
  packageDependencies: Readonly<Record<string, readonly string[]>>,
): void {
  const graph = new Map<string, readonly string[]>();
  for (const [packageId, references] of Object.entries(packageDependencies)) {
    const dependencyIds = references.map((reference) => parsePackageDependencyReference(reference).packageId);
    if (new Set(dependencyIds).size !== dependencyIds.length) {
      throw new CipherpolAdmissionError("INVALID_REFERENCE", "Import policy repeats a dependency package ID", {
        packageId,
      });
    }
    graph.set(packageId, dependencyIds);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (packageId: string, path: readonly string[]): void => {
    if (visiting.has(packageId)) {
      const cycleStart = path.indexOf(packageId);
      const cycle = [...path.slice(cycleStart), packageId];
      throw new CipherpolAdmissionError("DEPENDENCY_CYCLE", "Import policy package dependencies contain a cycle", {
        cycle,
      });
    }
    if (visited.has(packageId)) return;

    visiting.add(packageId);
    for (const dependencyId of graph.get(packageId) ?? []) {
      if (graph.has(dependencyId)) visit(dependencyId, [...path, packageId]);
    }
    visiting.delete(packageId);
    visited.add(packageId);
  };

  for (const packageId of [...graph.keys()].sort()) visit(packageId, []);
}

export function validateImportPolicyPackageDependencies(
  policy: SoftwareDevAgenticImportPolicy,
  artifacts: readonly ImportedArtifactDescriptor[] | Iterable<string>,
): void {
  const packageIds = new Set<string>();
  for (const artifact of artifacts) {
    packageIds.add(typeof artifact === "string" ? artifact : artifact.packageId);
  }

  for (const [packageId, references] of Object.entries(policy.packageDependencies)) {
    if (!packageIds.has(packageId)) {
      throw new CipherpolAdmissionError("MISSING_DEPENDENCY", "Import policy names an unknown package ID", {
        packageId,
      });
    }
    for (const reference of references) {
      const dependencyId = parsePackageDependencyReference(reference).packageId;
      if (!packageIds.has(dependencyId)) {
        throw new CipherpolAdmissionError("MISSING_DEPENDENCY", "Import policy references an unknown dependency package ID", {
          packageId,
          dependencyId,
        });
      }
    }
  }
  assertAcyclicPackageDependencies(policy.packageDependencies);
}

export async function loadImportPolicy(path: string): Promise<SoftwareDevAgenticImportPolicy> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    return invalidPolicy("Import policy is missing or unreadable", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const document = parseDocument(source, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    return invalidPolicy("Import policy contains malformed YAML", {
      path,
      issues: document.errors.map((error) => error.message),
    });
  }

  let raw: unknown;
  try {
    raw = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    return invalidPolicy("Import policy contains unsupported YAML aliases", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const parsed = importPolicySchema.safeParse(raw);
  if (!parsed.success) {
    return invalidPolicy("Import policy does not match cipherpol.import-policy/v1", {
      path,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }

  const policy: SoftwareDevAgenticImportPolicy = {
    schemaVersion: parsed.data.schemaVersion,
    modules: {
      "cipherpol-aegis": {
        ...parsed.data.modules["cipherpol-aegis"],
        capabilities: [...parsed.data.modules["cipherpol-aegis"].capabilities],
      },
      "cipherpol-9": {
        ...parsed.data.modules["cipherpol-9"],
        capabilities: [...parsed.data.modules["cipherpol-9"].capabilities],
      },
      "cipherpol-1": {
        ...parsed.data.modules["cipherpol-1"],
        capabilities: [...parsed.data.modules["cipherpol-1"].capabilities],
      },
    },
    packageDependencies: Object.fromEntries(
      Object.entries(parsed.data.packageDependencies).map(([packageId, references]) => [packageId, [...references]]),
    ),
  };
  assertAcyclicPackageDependencies(policy.packageDependencies);
  return policy;
}
