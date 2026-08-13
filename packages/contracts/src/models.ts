import type { z } from "zod";
import type {
  capabilityPackSchema, cipherpolLockSchema, cipherpolManifestSchema,
  generationSchema, packageRecordSchema, parityManifestSchema,
  playbookSchema, registryIndexSchema,
} from "./schemas.js";

export type PackageRecord = z.infer<typeof packageRecordSchema>;
export type CapabilityPack = z.infer<typeof capabilityPackSchema>;
export type Playbook = z.infer<typeof playbookSchema>;
export type RegistryIndex = z.infer<typeof registryIndexSchema>;
export type CipherpolManifest = z.infer<typeof cipherpolManifestSchema>;
export type Generation = z.infer<typeof generationSchema>;
export type CipherpolLock = z.infer<typeof cipherpolLockSchema>;
export type ParityManifest = z.infer<typeof parityManifestSchema>;
