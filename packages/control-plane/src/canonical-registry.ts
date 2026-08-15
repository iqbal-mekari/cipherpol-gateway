import type { CapabilityPack, PackageRecord, Playbook, RegistryEnvelope, RegistryIndex } from "@cipherpol/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface CurrentRegistryIndex {
  readonly index: RegistryIndex;
  readonly snapshotId: string;
}

/**
 * Reads the current (non-superseded) registry snapshot for a channel and returns
 * the `RegistryIndex` embedded in its stored, already-verified registry envelope.
 * Returns `undefined` if the channel has never been ingested.
 */
export async function loadCurrentRegistryIndex(
  client: SupabaseClient,
  channel: string,
): Promise<CurrentRegistryIndex | undefined> {
  const { data, error } = await client
    .from("registry_snapshots")
    .select("id, registry_envelope")
    .eq("channel", channel)
    .is("superseded_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return undefined;
  const envelope = data.registry_envelope as RegistryEnvelope;
  return { index: envelope.registryIndex, snapshotId: data.id as string };
}

// --- Row <-> canonical-record mapping for the `packages` / `capability_packs` /
// `playbooks` tables. Centralized here so `ingest.ts` (identity/conflict checks and
// writes) and `registry-reads.ts` (single-record reads) share one definition of the
// on-disk row shape instead of duplicating column names.

export function packageRecordToRow(record: PackageRecord): Record<string, unknown> {
  return {
    id: record.id,
    version: record.version,
    kind: record.kind,
    digest: record.digest,
    owner: record.owner,
    source_revision: record.sourceRevision,
    artifact_path: record.artifactPath,
    compatibility: record.compatibility,
    dependencies: record.dependencies,
    files: record.files,
    revoked: record.revoked,
  };
}

export function rowToPackageRecord(row: Record<string, unknown>): PackageRecord {
  return {
    id: row.id as string,
    kind: row.kind as PackageRecord["kind"],
    version: row.version as string,
    digest: row.digest as string,
    owner: row.owner as string,
    sourceRevision: row.source_revision as string,
    artifactPath: row.artifact_path as string,
    compatibility: row.compatibility as PackageRecord["compatibility"],
    dependencies: row.dependencies as PackageRecord["dependencies"],
    files: row.files as PackageRecord["files"],
    revoked: row.revoked as boolean,
  };
}

export function capabilityPackToRow(record: CapabilityPack): Record<string, unknown> {
  return {
    id: record.id,
    version: record.version,
    intents: record.intents,
    platforms: record.platforms,
    orchestrator: record.orchestrator,
    packages: record.packages,
    playbooks: record.playbooks,
    tool_bundle: record.toolBundle ?? null,
    required_evidence: record.requiredEvidence,
    revoked: record.revoked,
  };
}

export function rowToCapabilityPack(row: Record<string, unknown>): CapabilityPack {
  return {
    id: row.id as string,
    version: row.version as string,
    intents: row.intents as string[],
    platforms: row.platforms as CapabilityPack["platforms"],
    orchestrator: row.orchestrator as string,
    packages: row.packages as string[],
    playbooks: row.playbooks as string[],
    ...(row.tool_bundle != null ? { toolBundle: row.tool_bundle as string } : {}),
    requiredEvidence: row.required_evidence as string[],
    revoked: row.revoked as boolean,
  };
}

export function playbookToRow(record: Playbook): Record<string, unknown> {
  return {
    id: record.id,
    version: record.version,
    owner: record.owner,
    platforms: record.platforms,
    guidance_packages: record.guidancePackages,
    hook_packages: record.hookPackages,
    validator_packages: record.validatorPackages,
    rules: record.rules,
    revoked: record.revoked,
  };
}

export function rowToPlaybook(row: Record<string, unknown>): Playbook {
  return {
    id: row.id as string,
    version: row.version as string,
    owner: row.owner as string,
    platforms: row.platforms as Playbook["platforms"],
    guidancePackages: row.guidance_packages as string[],
    hookPackages: row.hook_packages as string[],
    validatorPackages: row.validator_packages as string[],
    rules: row.rules as Playbook["rules"],
    revoked: row.revoked as boolean,
  };
}
