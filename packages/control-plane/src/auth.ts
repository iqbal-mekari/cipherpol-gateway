import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The authenticated caller extracted from a valid Supabase session token. Only
 * the `sub` claim is surfaced: it is the immutable Supabase Auth user id used to
 * key `registry_snapshots.published_by` and `snapshot_reviews.reviewer_user_id`.
 */
export interface SessionUser {
  readonly userId: string;
}

/**
 * Base64url-decodes a single JWT segment (header, payload, or signature) into
 * raw bytes, returning `undefined` on malformed input instead of throwing. A JWT
 * segment is always base64url, so the standard `base64url` alphabet is the only
 * one that should ever be accepted.
 */
function decodeBase64UrlSegment(segment: string): Buffer | undefined {
  try {
    return Buffer.from(segment, "base64url");
  } catch {
    return undefined;
  }
}

/**
 * Verifies a caller-supplied Supabase Auth session token (`Authorization: Bearer
 * <token>`) against the project's JWT secret, using Supabase's default HS256
 * (HMAC-SHA256) signing. The signature check is performed with
 * `crypto.timingSafeEqual` over the token's own header+payload segments — no JWT
 * library is involved, and the token's own `alg` claim is never trusted (the
 * HMAC is always verified).
 *
 * Returns `{ userId: <sub claim> }` when the token is well-formed, correctly
 * signed, and not yet expired; returns `undefined` (never throws) when the
 * secret is unset, the header is absent or not a `Bearer` credential, the token
 * is structurally malformed, the signature does not verify, or `exp` has
 * already passed. `undefined` is deliberately *not* an error: callers decide
 * whether authentication is optional (ingest) or mandatory (reviews).
 */
export function verifySessionToken(
  jwtSecret: string | undefined,
  authorizationHeader: string | undefined,
): SessionUser | undefined {
  if (jwtSecret === undefined || authorizationHeader === undefined) return undefined;

  const bearerMatch = /^Bearer\s+(.+)$/.exec(authorizationHeader);
  if (bearerMatch === null) return undefined;
  const token = bearerMatch[1]?.trim();
  if (token === undefined || token.length === 0) return undefined;

  const segments = token.split(".");
  if (segments.length !== 3) return undefined;
  const headerSegment = segments[0];
  const payloadSegment = segments[1];
  const signatureSegment = segments[2];
  if (
    headerSegment === undefined
    || payloadSegment === undefined
    || signatureSegment === undefined
    || headerSegment.length === 0
    || payloadSegment.length === 0
    || signatureSegment.length === 0
  ) {
    return undefined;
  }

  // The JWS signing input is the two base64url-encoded segments joined by a dot
  // (not the decoded JSON), per RFC 7515 §5.1.
  const expectedSignature = createHmac("sha256", jwtSecret)
    .update(`${headerSegment}.${payloadSegment}`)
    .digest();
  const providedSignature = decodeBase64UrlSegment(signatureSegment);
  if (providedSignature === undefined || providedSignature.length !== expectedSignature.length) {
    return undefined;
  }
  if (!timingSafeEqual(providedSignature, expectedSignature)) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null) return undefined;

  const { sub, exp, role, aud } = payload as { sub?: unknown; exp?: unknown; role?: unknown; aud?: unknown };
  if (typeof sub !== "string" || sub.length === 0) return undefined;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
  if (exp <= Math.floor(Date.now() / 1000)) return undefined;
  // Defense in depth: a Supabase Auth user session always carries these two
  // claims. Requiring them means an unrelated HS256 token that happens to share
  // this project's JWT secret (e.g. a future token class minted elsewhere in the
  // stack with an attacker-influenced `sub`) cannot be mistaken for a genuine
  // authenticated-user session just because it verifies and has a `sub`.
  if (role !== "authenticated") return undefined;
  if (aud !== "authenticated") return undefined;

  return { userId: sub };
}
