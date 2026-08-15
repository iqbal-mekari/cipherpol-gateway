import type { PackageRecord, RegistryEnvelope } from "@cipherpol/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCurrentRegistryIndex, rowToPackageRecord } from "./canonical-registry.js";

/**
 * Lists the packages in the current registry snapshot for a channel, excluding any
 * whose `revoked` flag is set (revocation hides an artifact from every consumer).
 * `packages` is not itself channel-scoped in the schema (it is a content-addressed,
 * shared table across snapshots) — this reconstructs the channel's view from its
 * current snapshot's stored registry index, with post-ingest revocations overlaid
 * by `loadCurrentRegistryIndex`. Returns `undefined` if the channel has no current
 * snapshot.
 */
export async function listPackages(
  client: SupabaseClient,
  channel: string,
): Promise<readonly PackageRecord[] | undefined> {
  const current = await loadCurrentRegistryIndex(client, channel);
  if (!current) return undefined;
  return current.index.packages.filter((item) => !item.revoked);
}

/**
 * Looks up one package directly by its `(id, version)` identity, independent of any
 * channel or snapshot. Returns `undefined` if no such package has ever been ingested
 * OR if it has been revoked — revocation hides an artifact from every consumer,
 * including direct-identity lookup, exactly like `listPackages`/`resolveGeneration`.
 * A revoked artifact's content (files, artifact path, dependencies) must not remain
 * fetchable by a caller who already knows its exact `(id, version)`.
 */
export async function getPackage(
  client: SupabaseClient,
  id: string,
  version: string,
): Promise<PackageRecord | undefined> {
  const { data, error } = await client
    .from("packages")
    .select("id, version, kind, digest, owner, source_revision, artifact_path, compatibility, dependencies, files, revoked")
    .eq("id", id)
    .eq("version", version)
    .maybeSingle();
  if (error) throw error;
  if (!data) return undefined;
  const row = data as Record<string, unknown>;
  if (row.revoked === true) return undefined;
  return rowToPackageRecord(row);
}

export interface RegistrySnapshotSummary {
  readonly snapshotId: string;
  readonly channel: string;
  readonly sourceRevision: string;
  readonly keyId: string;
  readonly keyPurpose: "fixture" | "production";
  readonly ingestedAt: string;
  readonly registryEnvelope: RegistryEnvelope;
  readonly admissionEnvelopes: Readonly<Record<string, unknown>>;
  readonly publishedBy: string | undefined;
}

/**
 * Returns the current (non-superseded) registry snapshot for a channel, or
 * `undefined` if the channel has never been ingested.
 */
export async function getCurrentSnapshot(
  client: SupabaseClient,
  channel: string,
): Promise<RegistrySnapshotSummary | undefined> {
  const { data, error } = await client
    .from("registry_snapshots")
    .select("id, channel, source_revision, key_id, key_purpose, ingested_at, registry_envelope, admission_envelopes, published_by")
    .eq("channel", channel)
    .is("superseded_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return undefined;
  return {
    snapshotId: data.id as string,
    channel: data.channel as string,
    sourceRevision: data.source_revision as string,
    keyId: data.key_id as string,
    keyPurpose: data.key_purpose as "fixture" | "production",
    ingestedAt: data.ingested_at as string,
    registryEnvelope: data.registry_envelope as RegistryEnvelope,
    admissionEnvelopes: data.admission_envelopes as Readonly<Record<string, unknown>>,
    publishedBy: (data.published_by as string | null) ?? undefined,
  };
}
