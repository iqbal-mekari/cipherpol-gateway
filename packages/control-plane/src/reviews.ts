import type { SupabaseClient } from "@supabase/supabase-js";
import { ControlPlaneError } from "./errors.js";

export type ReviewDecision = "approved" | "rejected";

/** A persisted review row, in the control plane's camelCase record shape. */
export interface ReviewRecord {
  readonly id: string;
  readonly snapshotId: string;
  readonly reviewerUserId: string;
  readonly decision: ReviewDecision;
  readonly comment: string | undefined;
  readonly reviewedAt: string;
}

export interface RecordReviewInput {
  readonly snapshotId: string;
  readonly reviewerUserId: string;
  readonly decision: ReviewDecision;
  readonly comment?: string;
}

/**
 * Records one approve/reject decision against an existing registry snapshot.
 * The snapshot is validated up front so a review referencing a nonexistent
 * snapshot surfaces as a clean 404 rather than a raw Postgres foreign-key
 * violation (which would otherwise leak as a redacted 500).
 */
export async function recordReview(
  client: SupabaseClient,
  input: RecordReviewInput,
): Promise<{ id: string }> {
  const { data: snapshot, error: snapshotError } = await client
    .from("registry_snapshots")
    .select("id")
    .eq("id", input.snapshotId)
    .maybeSingle();
  if (snapshotError) throw snapshotError;
  if (snapshot === null) {
    throw new ControlPlaneError(
      "UNKNOWN_SNAPSHOT",
      404,
      `No snapshot with id ${input.snapshotId}`,
      { snapshotId: input.snapshotId },
    );
  }

  const { data, error } = await client
    .from("snapshot_reviews")
    .insert({
      snapshot_id: input.snapshotId,
      reviewer_user_id: input.reviewerUserId,
      decision: input.decision,
      comment: input.comment ?? null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return { id: (data as { id: string }).id };
}

/**
 * Lists every review recorded against a snapshot, oldest first. Reading review
 * history is not sensitive, so this is unauthenticated; a snapshot with no
 * reviews (or an unknown snapshot id) simply yields an empty list.
 */
export async function listReviews(
  client: SupabaseClient,
  snapshotId: string,
): Promise<readonly ReviewRecord[]> {
  const { data, error } = await client
    .from("snapshot_reviews")
    .select("id, snapshot_id, reviewer_user_id, decision, comment, reviewed_at")
    .eq("snapshot_id", snapshotId)
    .order("reviewed_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id as string,
    snapshotId: row.snapshot_id as string,
    reviewerUserId: row.reviewer_user_id as string,
    decision: row.decision as ReviewDecision,
    comment: (row.comment as string | null) ?? undefined,
    reviewedAt: row.reviewed_at as string,
  }));
}
