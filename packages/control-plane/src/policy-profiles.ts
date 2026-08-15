import { canonicalJson } from "@cipherpol/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ControlPlaneError } from "./errors.js";

export interface PolicyProfileRecord {
  readonly id: string;
  readonly name: string;
  /** `null` = unrestricted (any platform allowed). */
  readonly allowedPlatforms: readonly string[] | null;
  /** `null` = unrestricted (any capability pack allowed). */
  readonly allowedCapabilityPacks: readonly string[] | null;
  readonly createdAt: string;
}

export interface RegisterPolicyProfileInput {
  readonly id: string;
  readonly name: string;
  /** Omitted = unrestricted (stored as SQL `null`, not an empty array). */
  readonly allowedPlatforms?: readonly string[] | undefined;
  /** Omitted = unrestricted (stored as SQL `null`, not an empty array). */
  readonly allowedCapabilityPacks?: readonly string[] | undefined;
}

// --- Row <-> record mapping for the `policy_profiles` table. Mirrors the
// convention in `projects.ts`: one shared definition of the on-disk row shape used
// by both the write path (`registerPolicyProfile`) and the read paths
// (`getPolicyProfile`, and the resolve-time enforcement in `generations.ts`).

function policyProfileToRow(input: RegisterPolicyProfileInput): Record<string, unknown> {
  return {
    id: input.id,
    name: input.name,
    allowed_platforms: input.allowedPlatforms ?? null,
    allowed_capability_packs: input.allowedCapabilityPacks ?? null,
  };
}

function rowToPolicyProfile(row: Record<string, unknown>): PolicyProfileRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    allowedPlatforms: row.allowed_platforms as readonly string[] | null,
    allowedCapabilityPacks: row.allowed_capability_packs as readonly string[] | null,
    createdAt: row.created_at as string,
  };
}

/**
 * Compares a persisted policy-profile row against the row that would be written for
 * a re-registered profile, ignoring the identity column (`id`) and the DB-assigned
 * `created_at` timestamp. Any other differing column means the same `id` was
 * re-registered with different content.
 */
function rowContentEquals(existing: Record<string, unknown>, desired: Record<string, unknown>): boolean {
  const { id: _existingId, created_at: _createdAt, ...existingRest } = existing;
  const { id: _desiredId, ...desiredRest } = desired;
  return canonicalJson(existingRest) === canonicalJson(desiredRest);
}

/**
 * Narrows a thrown Postgrest error to its `code` field without an unchecked cast
 * (the same shape check `projects.ts` uses, since `instanceof PostgrestError` is
 * unreliable across pnpm's isolated per-package node_modules).
 */
function isPostgresErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/**
 * Idempotent-by-identity policy-profile registration, exactly like
 * `registerProject`: re-registering the same `id` with byte-identical content is a
 * no-op returning the existing id; differing content fails closed with
 * `POLICY_PROFILE_CONFLICT` before any write. Conflict-on-write is deliberately a
 * different failure from `POLICY_VIOLATION` (violation-on-resolve).
 */
export async function registerPolicyProfile(
  client: SupabaseClient,
  input: RegisterPolicyProfileInput,
): Promise<{ id: string }> {
  const desired = policyProfileToRow(input);

  const { data: existing, error: selectError } = await client
    .from("policy_profiles")
    .select("*")
    .eq("id", input.id)
    .maybeSingle();
  if (selectError) throw selectError;

  if (existing) {
    if (!rowContentEquals(existing as Record<string, unknown>, desired)) {
      throw new ControlPlaneError(
        "POLICY_PROFILE_CONFLICT",
        409,
        `Policy profile ${input.id} already exists with different content`,
        { id: input.id },
      );
    }
    return { id: (existing as Record<string, unknown>).id as string };
  }

  const { data: inserted, error: insertError } = await client
    .from("policy_profiles")
    .insert(desired)
    .select("id")
    .single();
  if (insertError) {
    if (!isPostgresErrorCode(insertError, "23505")) throw insertError;

    // Unique violation: a concurrent insert of this same `id` raced us. Resolve it
    // exactly like the pre-existing-row branch above.
    const { data: raced, error: racedSelectError } = await client
      .from("policy_profiles")
      .select("*")
      .eq("id", input.id)
      .maybeSingle();
    if (racedSelectError) throw racedSelectError;

    if (raced) {
      if (!rowContentEquals(raced as Record<string, unknown>, desired)) {
        throw new ControlPlaneError(
          "POLICY_PROFILE_CONFLICT",
          409,
          `Policy profile ${input.id} already exists with different content`,
          { id: input.id },
        );
      }
      return { id: (raced as Record<string, unknown>).id as string };
    }

    throw insertError;
  }
  return { id: (inserted as { id: string }).id };
}

/** Looks up one policy profile by id. Returns `undefined` if it does not exist. */
export async function getPolicyProfile(
  client: SupabaseClient,
  id: string,
): Promise<PolicyProfileRecord | undefined> {
  const { data, error } = await client
    .from("policy_profiles")
    .select("id, name, allowed_platforms, allowed_capability_packs, created_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return undefined;
  return rowToPolicyProfile(data as Record<string, unknown>);
}

/**
 * Assigns (or, with `null`, clears) the policy profile governing a project's
 * resolutions. Validates both referenced rows exist before writing so the
 * `projects.policy_profile_id` foreign key can never surface as a raw 500.
 */
export async function assignPolicyProfile(
  client: SupabaseClient,
  projectId: string,
  policyProfileId: string | null,
): Promise<void> {
  const { data: project, error: projectError } = await client
    .from("projects")
    .select("id")
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

  if (policyProfileId !== null) {
    const { data: profile, error: profileError } = await client
      .from("policy_profiles")
      .select("id")
      .eq("id", policyProfileId)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile) {
      throw new ControlPlaneError(
        "UNKNOWN_POLICY_PROFILE",
        404,
        `No policy profile with id ${policyProfileId}`,
        { id: policyProfileId },
      );
    }
  }

  const { error: updateError } = await client
    .from("projects")
    .update({ policy_profile_id: policyProfileId })
    .eq("id", projectId);
  if (updateError) throw updateError;
}
