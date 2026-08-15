import { createPublicKey } from "node:crypto";
import { verifyAdmission, verifyRegistryEnvelope } from "@cipherpol/admission";
import { canonicalJson } from "@cipherpol/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  capabilityPackToRow,
  packageRecordToRow,
  playbookToRow,
} from "./canonical-registry.js";
import { ControlPlaneError } from "./errors.js";

export interface ControlPlaneTrustConfig {
  readonly trustedKeyId: string;
  readonly trustedPublicKeyPem: string;
  readonly trustedKeyPurpose: "fixture" | "production";
  readonly allowFixtureKeys: boolean;
}

export interface IngestClosureInput {
  readonly registryEnvelope: unknown;
  readonly admissionEnvelopes: Readonly<Record<string, unknown>>;
  readonly channel: string;
  /**
   * The verified Google account email that submitted this ingestion via
   * `POST /registry/ingest` (see `server.ts`'s global auth gate / `google-auth.ts`),
   * recorded for audit/review. Optional at this function's level — not every
   * caller of `ingestClosure` goes through that HTTP route: `promotion.ts`
   * re-ingests a channel's existing envelope and passes through whatever
   * `publishedBy` (possibly `undefined`, for snapshots ingested before this
   * field existed) the source snapshot already recorded.
   */
  readonly publishedBy?: string;
}

export interface IngestClosureResult {
  readonly snapshotId: string;
}

type WriteTable = "packages" | "capability_packs" | "playbooks";

function wrapVerificationError(error: unknown, message: string): ControlPlaneError {
  return new ControlPlaneError("INVALID_ENVELOPE", 422, message, {
    cause: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Compares a persisted row against the row that would be written for a re-ingested
 * record, ignoring the identity columns (`id`, `version`), the DB-assigned
 * `created_at` timestamp, and `revoked`. `revoked` is intentionally excluded: it is
 * out-of-band, post-ingest mutable state set by `revocation.ts` directly on the
 * table, completely independent of the immutably-signed registry envelope — a
 * signed closure's embedded index always carries `revoked: false` for every item
 * (revocation cannot be baked in before the fact). Comparing it here would mean
 * re-ingesting the *exact same signed closure* — including via `promoteGeneration`,
 * which re-ingests a channel's already-verified current envelope verbatim — spuriously
 * throws `INGEST_CONFLICT` the moment any one of its packages/capability-packs/
 * playbooks has ever been revoked, even though nothing about the signed content
 * changed. Any other differing column means the same `(id, version)` identity was
 * re-ingested with genuinely different signed content.
 */
function rowContentEquals(existing: Record<string, unknown>, desired: Record<string, unknown>): boolean {
  const { id: _existingId, version: _existingVersion, created_at: _createdAt, revoked: _existingRevoked, ...existingRest } = existing;
  const { id: _desiredId, version: _desiredVersion, revoked: _desiredRevoked, ...desiredRest } = desired;
  return canonicalJson(existingRest) === canonicalJson(desiredRest);
}

/**
 * Read-only identity/conflict check for one table: for every desired row, either it
 * is genuinely new (queued for insertion), or an identical `(id, version)` row
 * already exists (a no-op), or a conflicting `(id, version)` row already exists
 * with different content (fails closed with `INGEST_CONFLICT` before any write).
 */
async function planTableInserts(
  client: SupabaseClient,
  table: WriteTable,
  identityLabel: string,
  desiredRows: readonly Record<string, unknown>[],
): Promise<readonly Record<string, unknown>[]> {
  if (desiredRows.length === 0) return [];
  const ids = [...new Set(desiredRows.map((row) => row.id as string))];

  const idBatchSize = 40;
  const existingByKey = new Map<string, Record<string, unknown>>();
  for (let offset = 0; offset < ids.length; offset += idBatchSize) {
    const batch = ids.slice(offset, offset + idBatchSize);
    const { data, error } = await client.from(table).select("*").in("id", batch);
    if (error) throw error;
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      existingByKey.set(`${row.id as string}@${row.version as string}`, row);
    }
  }

  const toInsert: Record<string, unknown>[] = [];
  for (const desired of desiredRows) {
    const id = desired.id as string;
    const version = desired.version as string;
    const existing = existingByKey.get(`${id}@${version}`);
    if (existing === undefined) {
      toInsert.push(desired);
      continue;
    }
    if (!rowContentEquals(existing, desired)) {
      throw new ControlPlaneError(
        "INGEST_CONFLICT",
        409,
        `${identityLabel} ${id}@${version} already exists with different content`,
        { id, version },
      );
    }
  }
  return toInsert;
}

/**
 * Verifies a Stage 2 signed closure (aggregate registry envelope plus every
 * referenced per-package admission envelope) and, only once every signature and
 * package-identity check has passed, persists it: new package/capability-pack/
 * playbook rows are inserted, and the channel's current snapshot pointer is moved
 * to the newly ingested envelope.
 *
 * Ordering and atomicity: package-level identity/conflict checks (`planTableInserts`)
 * are pure reads and run to completion for every table before any row is written, so
 * a rejected verification or a content conflict on any package/capability-pack/
 * playbook leaves the database completely unchanged. The final channel-snapshot
 * swap cannot be a single client-side transaction (supabase-js has no multi-statement
 * transaction API without a dedicated Postgres function, which is out of scope for
 * this slice's schema); the unique partial index `registry_snapshots_current_per_channel`
 * additionally forces "supersede the old snapshot, then insert the new one" as the
 * only ordering that can ever succeed. If the insert fails after the supersede
 * succeeded, the supersede is explicitly compensated (rolled back) so the channel
 * never durably loses its current snapshot.
 */
export async function ingestClosure(
  client: SupabaseClient,
  trust: ControlPlaneTrustConfig,
  input: IngestClosureInput,
): Promise<IngestClosureResult> {
  const envelopeKeyId = typeof input.registryEnvelope === "object" && input.registryEnvelope !== null
    ? (input.registryEnvelope as { keyId?: unknown }).keyId
    : undefined;
  if (envelopeKeyId !== trust.trustedKeyId) {
    throw new ControlPlaneError(
      "INVALID_ENVELOPE",
      422,
      "Registry envelope key ID does not match the server's trusted key",
      { envelopeKeyId },
    );
  }

  let publicKey;
  try {
    publicKey = createPublicKey(trust.trustedPublicKeyPem);
  } catch (error) {
    throw wrapVerificationError(error, "Trusted public key is not a valid PEM-encoded key");
  }

  let envelope;
  try {
    envelope = verifyRegistryEnvelope({
      envelope: input.registryEnvelope,
      trustedKeyId: trust.trustedKeyId,
      trustedKeyPurpose: trust.trustedKeyPurpose,
      publicKey,
      allowFixtureKeys: trust.allowFixtureKeys,
    });
  } catch (error) {
    throw wrapVerificationError(error, "Registry envelope failed verification");
  }

  const admissionPaths = new Set(envelope.closureManifest.mappings.map((mapping) => mapping.admissionPath));
  for (const admissionPath of admissionPaths) {
    const admissionEnvelope = input.admissionEnvelopes[admissionPath];
    if (admissionEnvelope === undefined) {
      throw new ControlPlaneError("INVALID_ENVELOPE", 422, `Missing admission envelope for ${admissionPath}`, { admissionPath });
    }
    try {
      await verifyAdmission(admissionEnvelope, {
        trustedKeyId: trust.trustedKeyId,
        trustedPublicKey: publicKey,
        allowFixtureKeys: trust.allowFixtureKeys,
      });
    } catch (error) {
      throw wrapVerificationError(error, `Admission envelope failed verification: ${admissionPath}`);
    }
  }

  // Package-level identity/conflict checks — reads only, no writes yet. Any
  // conflict throws here, before a single row has been written for this call.
  const packagesToInsert = await planTableInserts(
    client, "packages", "Package",
    envelope.registryIndex.packages.map(packageRecordToRow),
  );
  const capabilityPacksToInsert = await planTableInserts(
    client, "capability_packs", "Capability pack",
    envelope.registryIndex.capabilityPacks.map(capabilityPackToRow),
  );
  const playbooksToInsert = await planTableInserts(
    client, "playbooks", "Playbook",
    envelope.registryIndex.playbooks.map(playbookToRow),
  );

  // All package-level checks passed — perform the actual writes.
  if (packagesToInsert.length > 0) {
    const { error } = await client.from("packages").insert(packagesToInsert);
    if (error) throw error;
  }
  if (capabilityPacksToInsert.length > 0) {
    const { error } = await client.from("capability_packs").insert(capabilityPacksToInsert);
    if (error) throw error;
  }
  if (playbooksToInsert.length > 0) {
    const { error } = await client.from("playbooks").insert(playbooksToInsert);
    if (error) throw error;
  }

  const { data: superseded, error: supersedeError } = await client
    .from("registry_snapshots")
    .update({ superseded_at: new Date().toISOString() })
    .eq("channel", input.channel)
    .is("superseded_at", null)
    .select("id");
  if (supersedeError) throw supersedeError;
  const previousSnapshotId = (superseded as { id: string }[] | null)?.[0]?.id;

  const { data: inserted, error: insertError } = await client
    .from("registry_snapshots")
    .insert({
      channel: input.channel,
      source_revision: envelope.closureManifest.sourceRevision,
      key_id: envelope.keyId,
      key_purpose: envelope.keyPurpose,
      registry_envelope: envelope,
      admission_envelopes: input.admissionEnvelopes,
      published_by: input.publishedBy ?? null,
    })
    .select("id")
    .single();
  if (insertError) {
    if (previousSnapshotId !== undefined) {
      const { error: rollbackError } = await client
        .from("registry_snapshots")
        .update({ superseded_at: null })
        .eq("id", previousSnapshotId);
      if (rollbackError) {
        throw new Error(
          `Snapshot insert failed (${insertError.message}) and the compensating rollback of snapshot `
          + `${previousSnapshotId} also failed (${rollbackError.message}); channel "${input.channel}" `
          + "may be left without a current snapshot",
        );
      }
    }
    throw insertError;
  }

  return { snapshotId: (inserted as { id: string }).id };
}
