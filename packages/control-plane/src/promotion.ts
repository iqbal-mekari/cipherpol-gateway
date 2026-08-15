import type { SupabaseClient } from "@supabase/supabase-js";
import { ControlPlaneError } from "./errors.js";
import { ingestClosure, type ControlPlaneTrustConfig } from "./ingest.js";
import { getCurrentSnapshot } from "./registry-reads.js";

export interface PromoteGenerationInput {
  readonly fromChannel: string;
  readonly toChannel: string;
}

/**
 * Promotes a channel's current snapshot to another channel: reads the source
 * channel's stored envelopes (registry + admission) and re-ingests them under the
 * target channel. `ingestClosure` performs full signature verification and its
 * idempotency-by-identity again, so re-promoting a generation a channel already
 * has is a content-level no-op (no duplicate package rows) for free. The returned
 * `snapshotId` is the target channel's newly created snapshot row.
 */
export async function promoteGeneration(
  client: SupabaseClient,
  trust: ControlPlaneTrustConfig,
  input: PromoteGenerationInput,
): Promise<{ snapshotId: string }> {
  const current = await getCurrentSnapshot(client, input.fromChannel);
  if (current === undefined) {
    throw new ControlPlaneError(
      "UNKNOWN_CHANNEL",
      404,
      `No registry snapshot for channel ${input.fromChannel}`,
      { channel: input.fromChannel },
    );
  }
  return ingestClosure(client, trust, {
    registryEnvelope: current.registryEnvelope,
    admissionEnvelopes: current.admissionEnvelopes,
    channel: input.toChannel,
    ...(current.publishedBy === undefined ? {} : { publishedBy: current.publishedBy }),
  });
}
