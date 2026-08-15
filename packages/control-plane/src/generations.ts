import type { CipherpolManifest, Generation } from "@cipherpol/contracts";
import { CipherpolError, resolveGeneration, type Client } from "@cipherpol/resolver";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCurrentRegistryIndex } from "./canonical-registry.js";
import { ControlPlaneError } from "./errors.js";

/**
 * Loads the current registry snapshot for `manifest.channel` and resolves a
 * generation against it via the pure, unmodified `@cipherpol/resolver`
 * `resolveGeneration`. Maps a missing channel to `UNKNOWN_CHANNEL` (404) and any
 * `CipherpolError` raised during resolution to `RESOLUTION_FAILED` (422).
 */
export async function resolveGenerationFromRegistry(
  client: SupabaseClient,
  manifest: CipherpolManifest,
  resolverClient: Client,
): Promise<Generation> {
  const current = await loadCurrentRegistryIndex(client, manifest.channel);
  if (!current) {
    throw new ControlPlaneError(
      "UNKNOWN_CHANNEL",
      404,
      `No registry snapshot for channel ${manifest.channel}`,
      { channel: manifest.channel },
    );
  }
  try {
    return resolveGeneration(manifest, current.index, resolverClient);
  } catch (error) {
    if (error instanceof CipherpolError) {
      throw new ControlPlaneError("RESOLUTION_FAILED", 422, error.message, { code: error.code });
    }
    throw error;
  }
}
