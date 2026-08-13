import { z } from "zod";

const stableId = z.string().regex(/^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9._/-]*$/);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const relativePath = z.string().min(1).refine(
  (path) => !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes(".."),
  "path must be relative and traversal-free",
);
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
  files: z.array(z.object({ source: relativePath, target: relativePath })).min(1),
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

const parityState = z.enum(["equivalent", "normalized-dependency", "explicitly-unsupported"]);
export const parityManifestSchema = z.object({
  schemaVersion: z.literal("cipherpol.parity/v1"),
  sourceMarketplaceRevision: z.string().min(7),
  baseline: z.object({
    userFacing: z.literal(34),
    skills: z.literal(67),
    agents: z.literal(47),
    references: z.literal(36),
    cp1Tools: z.literal(17),
  }),
  entries: z.array(z.object({
    id: stableId,
    sourcePath: relativePath,
    artifactType: z.enum(["orchestrator", "procedure", "agent", "reference", "taxonomy", "mcp-tool", "setup-behavior"]),
    shipped: z.literal(true),
    state: parityState,
    trigger: z.string().min(1).optional(),
    composition: z.array(stableId).default([]),
    dependencies: z.array(stableId).default([]),
    platforms: z.array(z.string()).default([]),
    evidence: z.array(z.string().min(1)).min(1),
    decisionReference: z.string().min(1).optional(),
  }).superRefine((entry, context) => {
    if (entry.state === "explicitly-unsupported" && !entry.decisionReference) {
      context.addIssue({ code: "custom", path: ["decisionReference"], message: "unsupported entries require approval" });
    }
  })).min(1),
});
