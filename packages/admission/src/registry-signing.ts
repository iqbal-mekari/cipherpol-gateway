import { KeyObject, sign, verify } from "node:crypto";
import {
  canonicalJson,
  closureManifestSchema,
  registryEnvelopeSchema,
  registryIndexSchema,
  type ClosureManifest,
  type RegistryEnvelope,
  type RegistryIndex,
} from "@cipherpol/contracts";
import { z } from "zod";
import { type AdmissionErrorCode, CipherpolAdmissionError } from "./errors.js";

const REGISTRY_ENVELOPE_SCHEMA_VERSION = "cipherpol.registry-envelope/v1" as const;
const SIGNATURE_ALGORITHM = "Ed25519" as const;

export interface RegistrySigningOptions {
  readonly keyId: string;
  readonly keyPurpose: "fixture" | "production";
  readonly privateKey: KeyObject;
}

export interface RegistryVerificationOptions {
  readonly envelope: unknown;
  readonly trustedKeyId: string;
  readonly trustedKeyPurpose: "fixture" | "production";
  readonly publicKey: KeyObject;
  readonly allowFixtureKeys: boolean;
}

function parseOrThrow<Output, Input>(
  schema: z.ZodType<Output, z.ZodTypeDef, Input>,
  value: unknown,
  subject: string,
  code: AdmissionErrorCode,
): Output {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new CipherpolAdmissionError(code, `Invalid ${subject}`, {
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return result.data;
}

function registrySigningPayload(
  fields: Pick<RegistryEnvelope, "schemaVersion" | "registryIndex" | "closureManifest" | "keyId" | "algorithm" | "keyPurpose">,
): Buffer {
  return Buffer.from(canonicalJson(fields), "utf8");
}

/**
 * Signs `{schemaVersion, registryIndex, closureManifest, keyId, algorithm, keyPurpose}`
 * as canonical JSON via Ed25519. Signing the schema-normalized `registryIndex` and
 * `closureManifest` (rather than the raw caller-supplied objects) guarantees the
 * signed payload matches exactly what {@link verifyRegistryEnvelope} recomputes from
 * the parsed envelope.
 */
export function signRegistryEnvelope(
  registryIndex: RegistryIndex,
  closureManifest: ClosureManifest,
  options: RegistrySigningOptions,
): RegistryEnvelope {
  if (
    !(options.privateKey instanceof KeyObject)
    || options.privateKey.type !== "private"
    || options.privateKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new CipherpolAdmissionError("INVALID_SIGNING_KEY", "Registry signing key must be a private Ed25519 key");
  }

  const parsedRegistryIndex = parseOrThrow(registryIndexSchema, registryIndex, "registry index", "REGISTRY_INVALID");
  const parsedClosureManifest = parseOrThrow(closureManifestSchema, closureManifest, "closure manifest", "CLOSURE_INVALID");

  const signedFields = {
    schemaVersion: REGISTRY_ENVELOPE_SCHEMA_VERSION,
    registryIndex: parsedRegistryIndex,
    closureManifest: parsedClosureManifest,
    keyId: options.keyId,
    algorithm: SIGNATURE_ALGORITHM,
    keyPurpose: options.keyPurpose,
  } as const;

  let signature: string;
  try {
    signature = sign(null, registrySigningPayload(signedFields), options.privateKey).toString("base64");
  } catch (error) {
    throw new CipherpolAdmissionError(
      "INVALID_SIGNING_KEY",
      "Failed to sign registry envelope",
      error instanceof Error ? { causeName: error.name } : {},
    );
  }

  return parseOrThrow(
    registryEnvelopeSchema,
    { ...signedFields, signature },
    "composed registry envelope",
    "ENVELOPE_INVALID",
  );
}

/**
 * Verifies a registry envelope against a trusted key ID, key purpose, and public
 * key. Fails closed on: schema violations (malformed or tampered
 * `registryIndex`/`closureManifest` content), an untrusted key ID or key purpose,
 * a fixture-purpose key when `allowFixtureKeys` is false, and an invalid or
 * tampered Ed25519 signature.
 */
export function verifyRegistryEnvelope(options: RegistryVerificationOptions): RegistryEnvelope {
  const envelope = parseOrThrow(registryEnvelopeSchema, options.envelope, "registry envelope", "ENVELOPE_INVALID");

  if (envelope.keyPurpose === "fixture" && !options.allowFixtureKeys) {
    throw new CipherpolAdmissionError(
      "UNTRUSTED_KEY",
      "Fixture-purpose registry keys are not trusted unless explicitly allowed",
      { keyPurpose: envelope.keyPurpose },
    );
  }
  if (envelope.keyId !== options.trustedKeyId) {
    throw new CipherpolAdmissionError("UNTRUSTED_KEY", "Registry key ID is not trusted", { keyId: envelope.keyId });
  }
  if (envelope.keyPurpose !== options.trustedKeyPurpose) {
    throw new CipherpolAdmissionError(
      "UNTRUSTED_KEY",
      "Registry key purpose is not trusted",
      { keyPurpose: envelope.keyPurpose },
    );
  }
  if (
    !(options.publicKey instanceof KeyObject)
    || options.publicKey.type !== "public"
    || options.publicKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new CipherpolAdmissionError("UNTRUSTED_KEY", "Trusted registry key must be a public Ed25519 key");
  }

  let signatureValid: boolean;
  try {
    signatureValid = verify(
      null,
      registrySigningPayload({
        schemaVersion: envelope.schemaVersion,
        registryIndex: envelope.registryIndex,
        closureManifest: envelope.closureManifest,
        keyId: envelope.keyId,
        algorithm: envelope.algorithm,
        keyPurpose: envelope.keyPurpose,
      }),
      options.publicKey,
      Buffer.from(envelope.signature, "base64"),
    );
  } catch (error) {
    throw new CipherpolAdmissionError(
      "SIGNATURE_INVALID",
      "Registry signature verification failed",
      error instanceof Error ? { causeName: error.name } : {},
    );
  }
  if (!signatureValid) {
    throw new CipherpolAdmissionError("SIGNATURE_INVALID", "Registry signature is invalid");
  }

  return envelope;
}
