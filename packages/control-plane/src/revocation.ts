import { createPublicKey, verify } from "node:crypto";
import { canonicalJson } from "@cipherpol/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ControlPlaneError } from "./errors.js";
import type { ControlPlaneTrustConfig } from "./ingest.js";

/** The artifact-kind discriminator of a single revocation request. */
export interface RevocationRequest {
  readonly kind: "package" | "capabilityPack" | "playbook";
  readonly id: string;
  readonly version: string;
  readonly action: "revoke" | "unrevoke";
  /** ISO 8601 timestamp of the request; must be within 5 minutes of server time. */
  readonly requestedAt: string;
}

/** A signed revocation request: the request plus the Ed25519 identity that authorized it. */
export interface RevocationEnvelope {
  readonly keyId: string;
  readonly keyPurpose: "fixture" | "production";
  /** base64 Ed25519 signature over `canonicalJson(revocation)`. */
  readonly signature: string;
  readonly revocation: RevocationRequest;
}

export interface RevokeArtifactResult {
  readonly id: string;
  readonly version: string;
  readonly revoked: boolean;
}

const REVOCATION_WINDOW_MS = 5 * 60 * 1000;

const KIND_TO_TABLE = {
  package: "packages",
  capabilityPack: "capability_packs",
  playbook: "playbooks",
} as const;

/**
 * Revokes (or unrevokes) one artifact identity across every channel that contains
 * it. `revoked` is a global column on the shared `packages`/`capability_packs`/
 * `playbooks` tables — the registry-read/resolve paths already honor it — so this
 * is the single write path for hiding an artifact from every consumer.
 *
 * Verification mirrors `ingestClosure`: the envelope's `keyId`/`keyPurpose` are
 * checked against the server-pinned trust config *before* any crypto, the
 * `requestedAt` must fall within a ±5-minute replay window, and the Ed25519
 * signature is verified over `canonicalJson(revocation)` with the trusted public
 * key. Returns `undefined` when no row exists for `(kind, id, version)` so the
 * route handler can answer 404 without the function needing to know HTTP.
 */
export async function revokeArtifact(
  client: SupabaseClient,
  trust: ControlPlaneTrustConfig,
  envelope: RevocationEnvelope,
): Promise<RevokeArtifactResult | undefined> {
  if (envelope.keyId !== trust.trustedKeyId) {
    throw new ControlPlaneError(
      "INVALID_ENVELOPE",
      422,
      "Revocation envelope key ID does not match the server's trusted key",
      { keyId: envelope.keyId },
    );
  }
  if (envelope.keyPurpose !== trust.trustedKeyPurpose) {
    throw new ControlPlaneError(
      "INVALID_ENVELOPE",
      422,
      "Revocation envelope key purpose does not match the server's trusted key",
      { keyPurpose: envelope.keyPurpose },
    );
  }

  const requestedAtMs = Date.parse(envelope.revocation.requestedAt);
  if (!Number.isFinite(requestedAtMs)) {
    throw new ControlPlaneError(
      "INVALID_ENVELOPE",
      422,
      "Revocation requestedAt is not a valid ISO 8601 timestamp",
      { requestedAt: envelope.revocation.requestedAt },
    );
  }
  if (Math.abs(Date.now() - requestedAtMs) > REVOCATION_WINDOW_MS) {
    throw new ControlPlaneError(
      "INVALID_ENVELOPE",
      422,
      "Revocation requestedAt is outside the allowed ±5-minute window",
      { requestedAt: envelope.revocation.requestedAt },
    );
  }

  let publicKey;
  try {
    publicKey = createPublicKey(trust.trustedPublicKeyPem);
  } catch (error) {
    throw new ControlPlaneError(
      "INVALID_ENVELOPE",
      422,
      "Trusted public key is not a valid PEM-encoded key",
      error instanceof Error ? { causeName: error.name } : {},
    );
  }

  let signatureValid: boolean;
  try {
    signatureValid = verify(
      null,
      Buffer.from(canonicalJson(envelope.revocation), "utf8"),
      publicKey,
      Buffer.from(envelope.signature, "base64"),
    );
  } catch (error) {
    throw new ControlPlaneError(
      "INVALID_ENVELOPE",
      422,
      "Revocation signature verification failed",
      error instanceof Error ? { causeName: error.name } : {},
    );
  }
  if (!signatureValid) {
    throw new ControlPlaneError("INVALID_ENVELOPE", 422, "Revocation signature is invalid");
  }

  const table = KIND_TO_TABLE[envelope.revocation.kind];
  const revoked = envelope.revocation.action === "revoke";

  const { data, error } = await client
    .from(table)
    .update({ revoked })
    .eq("id", envelope.revocation.id)
    .eq("version", envelope.revocation.version)
    .select("id, version, revoked");
  if (error) throw error;

  const row = (data as readonly { id: string; version: string; revoked: boolean }[] | null)?.[0];
  if (row === undefined) return undefined;
  return { id: row.id, version: row.version, revoked: row.revoked };
}
