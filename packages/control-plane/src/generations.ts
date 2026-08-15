import type { CipherpolManifest, Generation } from "@cipherpol/contracts";
import { CipherpolError, resolveGeneration, type Client } from "@cipherpol/resolver";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCurrentRegistryIndex } from "./canonical-registry.js";
import { ControlPlaneError } from "./errors.js";
import { getPolicyProfile } from "./policy-profiles.js";

/**
 * Loads the current registry snapshot for `manifest.channel` and resolves a
 * generation against it via the pure, unmodified `@cipherpol/resolver`
 * `resolveGeneration`. Maps a missing channel to `UNKNOWN_CHANNEL` (404) and any
 * `CipherpolError` raised during resolution to `RESOLUTION_FAILED` (422).
 *
 * When `projectId` is supplied, the resolved generation is additionally checked
 * against that project's assigned policy profile (if any) *after* resolution has
 * succeeded: a project with no profile is unrestricted (today's behavior, byte-for-
 * byte unchanged), and an unknown `projectId` is `UNKNOWN_PROJECT` (404) — a
 * distinct failure from `UNKNOWN_CHANNEL`, which is about the registry channel, not
 * the project. A resolved generation (or manifest platform) that the profile does
 * not allow fails with `POLICY_VIOLATION` (422): the manifest resolves fine on its
 * own, but this project isn't allowed to activate what it resolved to.
 */
export async function resolveGenerationFromRegistry(
  client: SupabaseClient,
  manifest: CipherpolManifest,
  resolverClient: Client,
  projectId?: string,
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

  let generation: Generation;
  try {
    generation = resolveGeneration(manifest, current.index, resolverClient);
  } catch (error) {
    if (error instanceof CipherpolError) {
      throw new ControlPlaneError("RESOLUTION_FAILED", 422, error.message, { code: error.code });
    }
    throw error;
  }

  if (projectId !== undefined) {
    await enforceProjectPolicy(client, manifest, generation, projectId);
  }
  return generation;
}

/**
 * Enforces a project's assigned policy profile against an already-resolved
 * generation. A project with no `policy_profile_id` is unrestricted and returns
 * immediately. Violations are reported as `POLICY_VIOLATION` (422), naming the
 * offending capability pack or platform.
 */
async function enforceProjectPolicy(
  client: SupabaseClient,
  manifest: CipherpolManifest,
  generation: Generation,
  projectId: string,
): Promise<void> {
  const { data: project, error: projectError } = await client
    .from("projects")
    .select("id, policy_profile_id")
    .eq("id", projectId)
    .maybeSingle();
  if (projectError) throw projectError;
  if (!project) {
    throw new ControlPlaneError(
      "UNKNOWN_PROJECT",
      404,
      `No project with id ${projectId}`,
      { id: projectId },
    );
  }

  const policyProfileId = (project as Record<string, unknown>).policy_profile_id as string | null;
  if (!policyProfileId) return;

  const profile = await getPolicyProfile(client, policyProfileId);
  if (!profile) {
    throw new ControlPlaneError(
      "UNKNOWN_POLICY_PROFILE",
      404,
      `No policy profile with id ${policyProfileId}`,
      { id: policyProfileId },
    );
  }

  if (profile.allowedCapabilityPacks !== null) {
    const allowed = new Set(profile.allowedCapabilityPacks);
    for (const pack of generation.capabilityPacks) {
      if (!allowed.has(pack.id)) {
        throw new ControlPlaneError(
          "POLICY_VIOLATION",
          422,
          `Capability pack ${pack.id} is not allowed by policy profile ${policyProfileId}`,
          { capabilityPackId: pack.id, policyProfileId },
        );
      }
    }
  }

  if (profile.allowedPlatforms !== null) {
    const allowed = new Set(profile.allowedPlatforms);
    for (const platform of manifest.platforms) {
      if (!allowed.has(platform)) {
        throw new ControlPlaneError(
          "POLICY_VIOLATION",
          422,
          `Platform ${platform} is not allowed by policy profile ${policyProfileId}`,
          { platform, policyProfileId },
        );
      }
    }
  }
}
