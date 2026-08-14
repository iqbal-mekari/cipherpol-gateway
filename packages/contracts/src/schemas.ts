import { z } from "zod";

const stableId = z.string().regex(/^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9._/-]*$/);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const relativePath = z.string().min(1).refine(
  (path) => !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes(".."),
  "path must be relative and traversal-free",
);
export const artifactModeSchema = z.union([z.literal(0o644), z.literal(0o755)]);
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
  files: z.array(z.object({
    source: relativePath,
    target: relativePath,
    mode: artifactModeSchema.optional(),
  })).min(1),
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

export const parityStateSchema = z.enum([
  "equivalent",
  "normalized-dependency",
  "explicitly-unsupported",
]);

export const parityArtifactTypeV1Schema = z.enum([
  "orchestrator",
  "procedure",
  "agent",
  "reference",
  "taxonomy",
  "mcp-tool",
  "setup-behavior",
]);

export const parityArtifactTypeV2Schema = z.enum([
  "orchestrator",
  "internal-procedure",
  "contract",
  "agent",
  "reference",
  "taxonomy",
  "mcp-tool",
]);

export const parityArtifactTypeSchema = parityArtifactTypeV2Schema;

export const parityBaselineV1Schema = z.object({
  userFacing: z.literal(34),
  skills: z.literal(67),
  agents: z.literal(47),
  references: z.literal(36),
  cp1Tools: z.literal(17),
});

export const parityBaselineV2Schema = parityBaselineV1Schema.extend({
  classifiedEntries: z.literal(167),
  taxonomies: z.literal(1),
}).strict();

export const parityBaselineSchema = parityBaselineV2Schema;

const parityEntryV1BaseSchema = z.object({
  id: stableId,
  sourcePath: relativePath,
  artifactType: parityArtifactTypeV1Schema,
  shipped: z.literal(true),
  trigger: z.string().trim().min(1).optional(),
  composition: z.array(stableId).default([]),
  dependencies: z.array(stableId).default([]),
  platforms: z.array(z.string().trim().min(1)).default([]),
  evidence: z.array(z.string().trim().min(1)).min(1),
});

export const parityEntryV1Schema = z.discriminatedUnion("state", [
  parityEntryV1BaseSchema.extend({
    state: z.literal("equivalent"),
    decisionReference: z.never().optional(),
  }),
  parityEntryV1BaseSchema.extend({
    state: z.literal("normalized-dependency"),
    decisionReference: z.never().optional(),
  }),
  parityEntryV1BaseSchema.extend({
    state: z.literal("explicitly-unsupported"),
    decisionReference: z.string().trim().min(1),
  }),
]);

const parityEntryV2BaseSchema = z.object({
  id: stableId,
  name: z.string().trim().min(1),
  module: z.enum(["cipherpol-aegis", "cipherpol-9", "cipherpol-1"]),
  moduleVersion: version,
  sourceRevision: z.string().min(7),
  sourcePath: relativePath,
  artifactType: parityArtifactTypeV2Schema,
  shipped: z.literal(true),
  userInvocable: z.boolean().optional(),
  trigger: z.string().trim().min(1).optional(),
  composition: z.array(stableId).default([]),
  dependencies: z.array(stableId).default([]),
  platforms: z.array(z.string().trim().min(1)).default([]),
  permissions: z.array(z.string().trim().min(1)).default([]),
  toolCapabilities: z.array(z.string().trim().min(1)).default([]),
  mcpCapabilities: z.array(z.string().trim().min(1)).default([]),
  evidence: z.array(z.string().trim().min(1)).min(1),
}).strict();

export const parityEntryV2Schema = z.discriminatedUnion("state", [
  parityEntryV2BaseSchema.extend({
    state: z.literal("equivalent"),
    decisionReference: z.never().optional(),
  }),
  parityEntryV2BaseSchema.extend({
    state: z.literal("normalized-dependency"),
    decisionReference: z.never().optional(),
  }),
  parityEntryV2BaseSchema.extend({
    state: z.literal("explicitly-unsupported"),
    decisionReference: z.string().trim().min(1),
  }),
]);

export const parityEntrySchema = parityEntryV2Schema;

export const parityManifestV1Schema = z.object({
  schemaVersion: z.literal("cipherpol.parity/v1"),
  sourceMarketplaceRevision: z.string().min(7),
  baseline: parityBaselineV1Schema,
  entries: z.array(parityEntryV1Schema).min(1),
});

const parityManifestV2ObjectSchema = z.object({
  schemaVersion: z.literal("cipherpol.parity/v2"),
  sourceMarketplaceRevision: z.string().min(7),
  baseline: parityBaselineV2Schema,
  entries: z.array(parityEntryV2Schema).min(1),
}).strict();

function refineParityManifestV2(
  manifest: z.infer<typeof parityManifestV2ObjectSchema>,
  context: z.RefinementCtx,
): void {
  const ids = new Set<string>();
  const measured = {
    userFacing: 0,
    skills: 0,
    agents: 0,
    references: 0,
    cp1Tools: 0,
    classifiedEntries: 0,
    taxonomies: 0,
  };

  for (const [index, entry] of manifest.entries.entries()) {
    if (entry.sourceRevision !== manifest.sourceMarketplaceRevision) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "sourceRevision"],
        message: "entry revision must match source marketplace revision",
      });
    }
    if (ids.has(entry.id)) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "id"],
        message: "parity entry IDs must be unique",
      });
    }
    ids.add(entry.id);

    switch (entry.artifactType) {
      case "orchestrator":
        measured.skills += 1;
        if (entry.userInvocable === true) measured.userFacing += 1;
        break;
      case "internal-procedure":
      case "contract":
        measured.skills += 1;
        break;
      case "agent":
        measured.agents += 1;
        break;
      case "reference":
        measured.references += 1;
        break;
      case "mcp-tool":
        measured.cp1Tools += 1;
        break;
      case "taxonomy":
        measured.taxonomies += 1;
        break;
    }
  }

  measured.classifiedEntries = measured.skills
    + measured.agents
    + measured.references
    + measured.cp1Tools;

  for (const [index, entry] of manifest.entries.entries()) {
    for (const relation of ["composition", "dependencies"] as const) {
      for (const [relationIndex, targetId] of entry[relation].entries()) {
        if (!ids.has(targetId)) {
          context.addIssue({
            code: "custom",
            path: ["entries", index, relation, relationIndex],
            message: `${relation} target does not reference a parity entry`,
          });
        }
      }
    }
  }

  for (const key of Object.keys(measured) as Array<keyof typeof measured>) {
    if (measured[key] !== manifest.baseline[key]) {
      context.addIssue({
        code: "custom",
        path: ["baseline", key],
        message: `baseline declares ${manifest.baseline[key]} but entries measure ${measured[key]}`,
      });
    }
  }
}

export const parityManifestV2Schema = parityManifestV2ObjectSchema.superRefine(refineParityManifestV2);

export const parityManifestSchema = z.discriminatedUnion("schemaVersion", [
  parityManifestV1Schema,
  parityManifestV2ObjectSchema,
]).superRefine((manifest, context) => {
  if (manifest.schemaVersion === "cipherpol.parity/v2") {
    refineParityManifestV2(manifest, context);
  }
});

export const closurePackageMappingSchema = z.object({
  parityId: stableId,
  mappingType: z.literal("package"),
  packageId: stableId,
  packageVersion: version,
  packageDigest: digest,
  admissionPath: relativePath,
}).strict();

export const closureMcpMappingSchema = z.object({
  parityId: stableId,
  mappingType: z.literal("mcp-tool"),
  packageId: stableId,
  packageVersion: version,
  packageDigest: digest,
  admissionPath: relativePath,
  capability: z.string().regex(/^[a-z][a-z0-9_]*$/),
}).strict();
export const closureMappingSchema = z.discriminatedUnion("mappingType", [
  closurePackageMappingSchema,
  closureMcpMappingSchema,
]);

const closureManifestObjectSchema = z.object({
  schemaVersion: z.literal("cipherpol.closure/v1"),
  sourceRevision: z.string().min(7),
  paritySchemaVersion: z.literal("cipherpol.parity/v2"),
  parityManifestDigest: digest,
  mappings: z.array(closureMappingSchema).min(1),
}).strict();

export const closureManifestSchema = closureManifestObjectSchema.superRefine((manifest, context) => {
  const parityIds = new Set<string>();
  const mcpCapabilities = new Set<string>();
  let mcpCount = 0;
  let mcpDescriptor: string | undefined;

  for (const [index, mapping] of manifest.mappings.entries()) {
    if (parityIds.has(mapping.parityId)) {
      context.addIssue({
        code: "custom",
        path: ["mappings", index, "parityId"],
        message: "closure parity IDs must be unique",
      });
    }
    parityIds.add(mapping.parityId);

    if (mapping.mappingType !== "mcp-tool") continue;
    mcpCount += 1;
    if (mcpCapabilities.has(mapping.capability)) {
      context.addIssue({
        code: "custom",
        path: ["mappings", index, "capability"],
        message: "MCP capabilities must be distinct",
      });
    }
    mcpCapabilities.add(mapping.capability);

    const descriptor = [
      mapping.packageId,
      mapping.packageVersion,
      mapping.packageDigest,
      mapping.admissionPath,
    ].join("\0");
    if (mcpDescriptor === undefined) {
      mcpDescriptor = descriptor;
    } else if (descriptor !== mcpDescriptor) {
      context.addIssue({
        code: "custom",
        path: ["mappings", index, "packageId"],
        message: "MCP mappings must share one adapter descriptor",
      });
    }
  }

  if (mcpCount !== 17) {
    context.addIssue({
      code: "custom",
      path: ["mappings"],
      message: `closure must contain exactly 17 MCP mappings; received ${mcpCount}`,
    });
  }
});

const registryEnvelopeObjectSchema = z.object({
  schemaVersion: z.literal("cipherpol.registry-envelope/v1"),
  registryIndex: registryIndexSchema,
  closureManifest: closureManifestSchema,
  keyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  algorithm: z.literal("Ed25519"),
  keyPurpose: z.enum(["fixture", "production"]),
  signature: z.string().min(1),
}).strict();

export const registryEnvelopeSchema = registryEnvelopeObjectSchema.superRefine((envelope, context) => {
  const packagesById = new Map<string, z.infer<typeof packageRecordSchema>>();
  const mappedPackageIds = new Set<string>();

  for (const [index, packageRecord] of envelope.registryIndex.packages.entries()) {
    if (packagesById.has(packageRecord.id)) {
      context.addIssue({
        code: "custom",
        path: ["registryIndex", "packages", index, "id"],
        message: "registry package IDs must be unique",
      });
    } else {
      packagesById.set(packageRecord.id, packageRecord);
    }
  }

  for (const [index, mapping] of envelope.closureManifest.mappings.entries()) {
    const packageRecord = packagesById.get(mapping.packageId);
    if (packageRecord === undefined) {
      context.addIssue({
        code: "custom",
        path: ["closureManifest", "mappings", index, "packageId"],
        message: "closure mapping references an unknown registry package",
      });
      continue;
    }

    mappedPackageIds.add(mapping.packageId);
    if (mapping.packageVersion !== packageRecord.version) {
      context.addIssue({
        code: "custom",
        path: ["closureManifest", "mappings", index, "packageVersion"],
        message: "closure mapping version does not match registry package",
      });
    }
    if (mapping.packageDigest !== packageRecord.digest) {
      context.addIssue({
        code: "custom",
        path: ["closureManifest", "mappings", index, "packageDigest"],
        message: "closure mapping digest does not match registry package",
      });
    }
  }

  for (const [index, packageRecord] of envelope.registryIndex.packages.entries()) {
    if (!mappedPackageIds.has(packageRecord.id)) {
      context.addIssue({
        code: "custom",
        path: ["registryIndex", "packages", index, "id"],
        message: "every registry package must have a closure mapping",
      });
    }
  }
});
