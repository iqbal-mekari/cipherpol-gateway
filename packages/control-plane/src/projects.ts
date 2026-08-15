import { canonicalJson } from "@cipherpol/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ControlPlaneError } from "./errors.js";

export interface ProjectRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly defaultChannel: "canary" | "stable" | "pinned";
  readonly platforms: readonly string[];
  readonly owners: readonly string[];
  readonly registeredAt: string;
}

// --- Row <-> record mapping for the `projects` table. Mirrors the convention in
// `canonical-registry.ts`: one shared definition of the on-disk row shape used by
// both the write path (`registerProject`) and the read paths (`getProjectBySlug`,
// `listProjects`) below.

function projectRecordToRow(record: Omit<ProjectRecord, "registeredAt">): Record<string, unknown> {
  return {
    id: record.id,
    slug: record.slug,
    name: record.name,
    default_channel: record.defaultChannel,
    platforms: record.platforms,
    owners: record.owners,
  };
}

function rowToProjectRecord(row: Record<string, unknown>): ProjectRecord {
  return {
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    defaultChannel: row.default_channel as ProjectRecord["defaultChannel"],
    platforms: row.platforms as readonly string[],
    owners: row.owners as readonly string[],
    registeredAt: row.registered_at as string,
  };
}

/**
 * Compares a persisted project row against the row that would be written for a
 * re-registered project, ignoring the identity column (`id`), the DB-assigned
 * `registered_at` timestamp, and `policy_profile_id` (assigned separately via the
 * policy-profiles API, never part of `registerProject`'s input — `desired` never
 * carries it, so it must not participate in the identity comparison). Any other
 * differing column means the same `id` was re-registered with different content.
 */
function rowContentEquals(existing: Record<string, unknown>, desired: Record<string, unknown>): boolean {
  const { id: _existingId, registered_at: _registeredAt, policy_profile_id: _policyProfileId, ...existingRest } = existing;
  const { id: _desiredId, ...desiredRest } = desired;
  return canonicalJson(existingRest) === canonicalJson(desiredRest);
}

/**
 * Narrows a thrown Postgrest error to its `code` field without an unchecked cast.
 * Supabase's client re-bundles `@supabase/postgrest-js` per-package under pnpm's
 * isolated node_modules layout, so `instanceof PostgrestError` cannot be relied on
 * across package boundaries — this checks the error's actual shape instead.
 */
function isPostgresErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/**
 * Idempotent-by-identity project registration, exactly like package ingestion: a
 * re-registration of the same `id` with byte-identical content (slug/name/
 * defaultChannel/platforms/owners) is a no-op that returns the existing id;
 * differing content fails closed with `PROJECT_CONFLICT` before any write.
 */
export async function registerProject(
  client: SupabaseClient,
  input: Omit<ProjectRecord, "registeredAt">,
): Promise<{ id: string }> {
  const desired = projectRecordToRow(input);

  const { data: existing, error: selectError } = await client
    .from("projects")
    .select("*")
    .eq("id", input.id)
    .maybeSingle();
  if (selectError) throw selectError;

  if (existing) {
    if (!rowContentEquals(existing as Record<string, unknown>, desired)) {
      throw new ControlPlaneError(
        "PROJECT_CONFLICT",
        409,
        `Project ${input.id} already exists with different content`,
        { id: input.id },
      );
    }
    return { id: (existing as Record<string, unknown>).id as string };
  }

  const { data: inserted, error: insertError } = await client
    .from("projects")
    .insert(desired)
    .select("id")
    .single();
  if (insertError) {
    if (!isPostgresErrorCode(insertError, "23505")) throw insertError;

    // Unique violation: either a concurrent insert of this same `id` raced us (in
    // which case we resolve it exactly like the pre-existing-row branch above), or
    // `slug` collides with a different, already-registered project's `id`.
    const { data: raced, error: racedSelectError } = await client
      .from("projects")
      .select("*")
      .eq("id", input.id)
      .maybeSingle();
    if (racedSelectError) throw racedSelectError;

    if (raced) {
      if (!rowContentEquals(raced as Record<string, unknown>, desired)) {
        throw new ControlPlaneError(
          "PROJECT_CONFLICT",
          409,
          `Project ${input.id} already exists with different content`,
          { id: input.id },
        );
      }
      return { id: (raced as Record<string, unknown>).id as string };
    }

    throw new ControlPlaneError(
      "PROJECT_CONFLICT",
      409,
      `Project slug ${input.slug} is already registered to a different project`,
      { slug: input.slug },
    );
  }
  return { id: (inserted as { id: string }).id };
}

/**
 * Looks up one project by its human-facing `slug`. Returns `undefined` if no
 * project with that slug has ever been registered.
 */
export async function getProjectBySlug(
  client: SupabaseClient,
  slug: string,
): Promise<ProjectRecord | undefined> {
  const { data, error } = await client
    .from("projects")
    .select("id, slug, name, default_channel, platforms, owners, registered_at")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  if (!data) return undefined;
  return rowToProjectRecord(data as Record<string, unknown>);
}

/** Lists every registered project. */
export async function listProjects(client: SupabaseClient): Promise<readonly ProjectRecord[]> {
  const { data, error } = await client
    .from("projects")
    .select("id, slug, name, default_channel, platforms, owners, registered_at");
  if (error) throw error;
  return (data as Record<string, unknown>[]).map(rowToProjectRecord);
}
