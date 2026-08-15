import type { PackageRecord, RegistryEnvelope } from "@cipherpol/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCurrentRegistryIndex, rowToPackageRecord } from "./canonical-registry.js";

/**
 * Lists the packages in the current registry snapshot for a channel. `packages` is
 * not itself channel-scoped in the schema (it is a content-addressed, shared table
 * across snapshots) — this reconstructs the channel's view from its current
 * snapshot's stored registry index. Returns `undefined` if the channel has no
 * current snapshot.
 */
export async function listPackages(
  client: SupabaseClient,
  channel: string,
): Promise<readonly PackageRecord[] | undefined> {
  const current = await loadCurrentRegistryIndex(client, channel);
  if (!current) return undefined;
  return current.index.packages;
}

/**
 * Looks up one package directly by its `(id, version)` identity, independent of any
 * channel or snapshot. Returns `undefined` if no such package has ever been ingested.
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
  return rowToPackageRecord(data as Record<string, unknown>);
}

export interface RegistrySnapshotSummary {
  readonly snapshotId: string;
  readonly channel: string;
  readonly sourceRevision: string;
  readonly keyId: string;
  readonly keyPurpose: "fixture" | "production";
  readonly ingestedAt: string;
  readonly registryEnvelope: RegistryEnvelope;
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
    .select("id, channel, source_revision, key_id, key_purpose, ingested_at, registry_envelope")
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
  };
}
