import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cipherpolManifestSchema, registryIndexSchema,
  type CipherpolManifest, type RegistryIndex,
} from "@cipherpol/contracts";
import { parse } from "yaml";
import { CipherpolError } from "./errors.js";

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
