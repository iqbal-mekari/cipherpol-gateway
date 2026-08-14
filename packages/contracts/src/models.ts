import type { z } from "zod";
import type {
  artifactModeSchema, capabilityPackSchema, cipherpolLockSchema, cipherpolManifestSchema,
  closureManifestSchema, closureMappingSchema, closureMcpMappingSchema,
  closurePackageMappingSchema, generationSchema, packageRecordSchema,
  parityArtifactTypeSchema, parityArtifactTypeV1Schema, parityArtifactTypeV2Schema,
  parityBaselineSchema, parityBaselineV1Schema, parityBaselineV2Schema,
  parityEntrySchema, parityEntryV1Schema, parityEntryV2Schema,
  parityManifestSchema, parityManifestV1Schema, parityManifestV2Schema,
  parityStateSchema, playbookSchema, registryEnvelopeSchema, registryIndexSchema,
} from "./schemas.js";

export type PackageRecord = z.infer<typeof packageRecordSchema>;
export type CapabilityPack = z.infer<typeof capabilityPackSchema>;
export type Playbook = z.infer<typeof playbookSchema>;
export type RegistryIndex = z.infer<typeof registryIndexSchema>;
export type CipherpolManifest = z.infer<typeof cipherpolManifestSchema>;
export type Generation = z.infer<typeof generationSchema>;
export type CipherpolLock = z.infer<typeof cipherpolLockSchema>;
export type ArtifactMode = z.infer<typeof artifactModeSchema>;
export type ClosurePackageMapping = z.infer<typeof closurePackageMappingSchema>;
export type ClosureMcpMapping = z.infer<typeof closureMcpMappingSchema>;
export type ClosureMapping = z.infer<typeof closureMappingSchema>;
export type ClosureManifest = z.infer<typeof closureManifestSchema>;
export type RegistryEnvelope = z.infer<typeof registryEnvelopeSchema>;
export type ParityManifest = z.infer<typeof parityManifestSchema>;
export type ParityManifestV1 = z.infer<typeof parityManifestV1Schema>;
export type ParityManifestV2 = z.infer<typeof parityManifestV2Schema>;
export type ParityState = z.infer<typeof parityStateSchema>;
export type ParityArtifactType = z.infer<typeof parityArtifactTypeSchema>;
export type ParityArtifactTypeV1 = z.infer<typeof parityArtifactTypeV1Schema>;
export type ParityArtifactTypeV2 = z.infer<typeof parityArtifactTypeV2Schema>;
export type ParityBaseline = z.infer<typeof parityBaselineSchema>;
export type ParityBaselineV1 = z.infer<typeof parityBaselineV1Schema>;
export type ParityBaselineV2 = z.infer<typeof parityBaselineV2Schema>;
export type ParityEntry = z.infer<typeof parityEntrySchema>;
export type ParityEntryV1 = z.infer<typeof parityEntryV1Schema>;
export type ParityEntryV2 = z.infer<typeof parityEntryV2Schema>;
