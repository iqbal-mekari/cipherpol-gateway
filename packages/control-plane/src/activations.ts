import type { SupabaseClient } from "@supabase/supabase-js";
import { ControlPlaneError } from "./errors.js";

export interface ActivationRecord {
  readonly id: string;
  readonly projectId: string | undefined;
  readonly channel: string;
  readonly snapshotId: string;
  readonly generationDigest: string;
  readonly claudeCodeVersion: string;
  readonly capabilities: readonly string[];
  readonly activatedAt: string;
}

export interface RecordActivationInput {
  readonly projectId?: string;
  readonly channel: string;
  readonly snapshotId: string;
  readonly generationDigest: string;
  readonly claudeCodeVersion: string;
  readonly capabilities?: readonly string[];
}

export interface ListActivationsFilters {
  readonly projectId?: string;
  readonly channel?: string;
  readonly limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function rowToActivationRecord(row: Record<string, unknown>): ActivationRecord {
  return {
    id: row.id as string,
    projectId: (row.project_id as string | null) ?? undefined,
    channel: row.channel as string,
    snapshotId: row.snapshot_id as string,
    generationDigest: row.generation_digest as string,
    claudeCodeVersion: row.claude_code_version as string,
    capabilities: row.capabilities as readonly string[],
    activatedAt: row.activated_at as string,
  };
}

/**
 * Records a client-reported activation as an audit-trail row. This is telemetry,
 * not a security boundary: a forged record cannot cause a client to run anything
 * it did not already resolve. The referenced `snapshotId` (and `projectId`, when
 * given) are validated to exist before the insert so a dangling reference
 * surfaces as a clean 404 rather than a raw foreign-key-violation 500.
 */
export async function recordActivation(
  client: SupabaseClient,
  input: RecordActivationInput,
): Promise<{ id: string }> {
  const { data: snapshot, error: snapshotError } = await client
    .from("registry_snapshots")
    .select("id")
    .eq("id", input.snapshotId)
    .maybeSingle();
  if (snapshotError) throw snapshotError;
  if (!snapshot) {
    throw new ControlPlaneError(
      "UNKNOWN_SNAPSHOT",
      404,
      `No registry snapshot with id ${input.snapshotId}`,
      { snapshotId: input.snapshotId },
    );
  }

  if (input.projectId !== undefined) {
    const { data: project, error: projectError } = await client
      .from("projects")
      .select("id")
      .eq("id", input.projectId)
      .maybeSingle();
    if (projectError) throw projectError;
    if (!project) {
      throw new ControlPlaneError(
        "UNKNOWN_PROJECT",
        404,
        `No project with id ${input.projectId}`,
        { projectId: input.projectId },
      );
    }
  }

  const { data: inserted, error: insertError } = await client
    .from("activation_records")
    .insert({
      project_id: input.projectId ?? null,
      channel: input.channel,
      snapshot_id: input.snapshotId,
      generation_digest: input.generationDigest,
      claude_code_version: input.claudeCodeVersion,
      capabilities: input.capabilities ?? [],
    })
    .select("id")
    .single();
  if (insertError) throw insertError;
  return { id: inserted.id as string };
}

/**
 * Lists activation records newest-first. `limit` defaults to 50 and is silently
 * clamped to a maximum of 500 — an oversized request is honored at the cap, never
 * rejected.
 */
export async function listActivations(
  client: SupabaseClient,
  filters: ListActivationsFilters,
): Promise<readonly ActivationRecord[]> {
  const limit = Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  let query = client
    .from("activation_records")
    .select("id, project_id, channel, snapshot_id, generation_digest, claude_code_version, capabilities, activated_at");

  if (filters.projectId !== undefined) {
    query = query.eq("project_id", filters.projectId);
  }
  if (filters.channel !== undefined) {
    query = query.eq("channel", filters.channel);
  }

  const { data, error } = await query.order("activated_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return (data as Record<string, unknown>[]).map(rowToActivationRecord);
}
