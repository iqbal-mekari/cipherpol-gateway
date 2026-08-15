import type { SupabaseClient } from "@supabase/supabase-js";

export interface IngestHistoryEntry {
  readonly id: string;
  readonly channel: string;
  readonly sourceRevision: string;
  readonly keyId: string;
  readonly publishedBy: string | undefined;
  readonly ingestedAt: string;
  readonly supersededAt: string | undefined;
}

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 500;

/**
 * Lists registry snapshot metadata, newest-first by `ingested_at`. Deliberately
 * selects only the lightweight columns — never `registry_envelope` or
 * `admission_envelopes` — so listing history stays a cheap, small payload even as
 * snapshots accumulate. `limit` defaults to 50 and is clamped to [1, 500].
 */
export async function listIngestHistory(
  client: SupabaseClient,
  filters: { readonly channel?: string; readonly limit?: number } = {},
): Promise<readonly IngestHistoryEntry[]> {
  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_HISTORY_LIMIT, 1), MAX_HISTORY_LIMIT);

  let query = client
    .from("registry_snapshots")
    .select("id, channel, source_revision, key_id, published_by, ingested_at, superseded_at")
    .order("ingested_at", { ascending: false })
    .limit(limit);

  if (filters.channel !== undefined && filters.channel.length > 0) {
    query = query.eq("channel", filters.channel);
  }

  const { data, error } = await query;
  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id as string,
    channel: row.channel as string,
    sourceRevision: row.source_revision as string,
    keyId: row.key_id as string,
    publishedBy: (row.published_by as string | null) ?? undefined,
    ingestedAt: row.ingested_at as string,
    supersededAt: (row.superseded_at as string | null) ?? undefined,
  }));
}
