import { createPublicKey, verify } from "node:crypto";

/**
 * `gcloud auth print-identity-token` cannot mint a custom-audience token for a
 * regular (non-service-account) user — verified directly: passing `--audiences`
 * for a user account fails with "Invalid account type for `--audiences`.
 * Requires valid service account." Every human engineer's identity token
 * therefore carries this fixed, Google-published "Google Cloud SDK" OAuth
 * client ID as both `aud` and `azp`, regardless of which Google account signs
 * in. This is not a secret and not something we chose — it is Google's own
 * constant for the `gcloud`/Cloud SDK installed-app flow. Real access control
 * comes from the domain check below (`email` + `email_verified`), which is
 * fully independent of `aud` sharing; the audience check only rules out
 * tokens that were never a `gcloud`-issued human identity token at all (e.g.
 * a service-account token minted for an unrelated Cloud API).
 */
const DEFAULT_ALLOWED_AUDIENCE = "32555940559.apps.googleusercontent.com";

const DEFAULT_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ALLOWED_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

export interface GoogleAuthConfig {
  /**
   * Organization email domains allowed to authenticate, given WITHOUT the
   * leading `@` (e.g. "mekari.com"). An email matches when its lowercased
   * address ends with `"@" + domain` (domain also lowercased).
   */
  readonly allowedEmailDomains: readonly string[];
  /**
   * Exact full email addresses allowed to authenticate (e.g.
   * "iqbalmineraltown@gmail.com"), matched by case-insensitive whole-address
   * equality. This lets an operator allowlist a personal Gmail account without
   * opening up the entire gmail.com domain.
   */
  readonly allowedEmails: readonly string[];
  /** Overridable for tests; defaults to Google's real JWKS endpoint. */
  readonly jwksUrl?: string;
  /** Overridable for tests; defaults to the well-known Cloud SDK client ID. */
  readonly allowedAudience?: string;
}

export interface GoogleIdentity {
  readonly email: string;
  readonly sub: string;
}

interface Jwk {
  readonly kty: string;
  readonly n: string;
  readonly e: string;
  readonly kid: string;
  readonly alg?: string;
}

interface JwksCacheEntry {
  readonly fetchedAt: number;
  readonly keysByKid: ReadonlyMap<string, Jwk>;
}

const jwksCacheByUrl = new Map<string, JwksCacheEntry>();

function decodeBase64UrlJson(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

async function fetchJwks(jwksUrl: string): Promise<ReadonlyMap<string, Jwk>> {
  const response = await fetch(jwksUrl);
  if (!response.ok) throw new Error(`Failed to fetch Google JWKS (${response.status})`);
  const body = await response.json() as { keys?: readonly Jwk[] };
  const keysByKid = new Map<string, Jwk>();
  for (const key of body.keys ?? []) {
    if (key.kty === "RSA" && typeof key.kid === "string") keysByKid.set(key.kid, key);
  }
  return keysByKid;
}

/**
 * Resolves the RSA public key for `kid`, using a 1-hour in-memory cache keyed
 * by `jwksUrl` (tests inject their own `jwksUrl` to avoid any real network
 * call). A fresh-cache `kid` hit returns immediately. A fresh-cache `kid`
 * *miss* is NOT re-fetched unless the last fetch is at least
 * `MIN_REFRESH_INTERVAL_MS` old — an unauthenticated caller can trivially
 * craft a token with a novel `kid` (all other claims are public constants),
 * so re-fetching on every unknown kid would let one client force an outbound
 * HTTPS fetch to Google per request (egress amplification / low-grade DoS;
 * a Google-side quota hit would then fail the legitimate rotation re-fetch
 * closed and 401 every real user). Bounding the re-fetch to once per minute
 * keeps legitimate key rotation recoverable (well inside the 1h TTL) while
 * capping the amplification. A `kid` still absent after a re-fetch is
 * genuinely unknown.
 */
const MIN_REFRESH_INTERVAL_MS = 60 * 1000;

async function resolveSigningKey(jwksUrl: string, kid: string): Promise<Jwk | undefined> {
  const cached = jwksCacheByUrl.get(jwksUrl);
  const now = Date.now();
  const isFresh = cached !== undefined && (now - cached.fetchedAt) < JWKS_CACHE_TTL_MS;
  if (isFresh && cached.keysByKid.has(kid)) return cached.keysByKid.get(kid);
  if (isFresh && (now - cached.fetchedAt) < MIN_REFRESH_INTERVAL_MS) return undefined;

  const keysByKid = await fetchJwks(jwksUrl);
  jwksCacheByUrl.set(jwksUrl, { fetchedAt: now, keysByKid });
  return keysByKid.get(kid);
}

/**
 * Verifies a Google-issued OpenID Connect ID token (`Authorization: Bearer
 * <token>`) end to end: RS256 signature against Google's live JWKS (imported
 * directly as a JWK via `node:crypto` — no JWT library), issuer, audience,
 * expiry, `email_verified`, and that `email` either belongs to one of
 * `config.allowedEmailDomains` or exactly equals one of `config.allowedEmails`.
 * Returns `undefined` (never throws) on any failure — malformed input, bad
 * signature, wrong issuer/audience, expired token, unverified email, or a
 * non-allowed email are all indistinguishable to the caller, matching
 * `verifySessionToken`'s existing convention of failing closed without leaking
 * which check failed.
 */
export async function verifyGoogleIdToken(
  config: GoogleAuthConfig,
  authorizationHeader: string | undefined,
): Promise<GoogleIdentity | undefined> {
  if (authorizationHeader === undefined) return undefined;
  const bearerMatch = /^Bearer\s+(.+)$/.exec(authorizationHeader);
  if (bearerMatch === null) return undefined;
  const token = bearerMatch[1]?.trim();
  if (token === undefined || token.length === 0) return undefined;

  const segments = token.split(".");
  if (segments.length !== 3) return undefined;
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  if (headerSegment === undefined || payloadSegment === undefined || signatureSegment === undefined) return undefined;
  if (headerSegment.length === 0 || payloadSegment.length === 0 || signatureSegment.length === 0) return undefined;

  const header = decodeBase64UrlJson(headerSegment) as { alg?: unknown; kid?: unknown } | undefined;
  if (header === undefined || header.alg !== "RS256" || typeof header.kid !== "string") return undefined;

  const payload = decodeBase64UrlJson(payloadSegment) as {
    iss?: unknown; aud?: unknown; exp?: unknown; email?: unknown; email_verified?: unknown;
    sub?: unknown;
  } | undefined;
  if (payload === undefined) return undefined;
  if (typeof payload.iss !== "string" || !ALLOWED_ISSUERS.has(payload.iss)) return undefined;
  if (typeof payload.aud !== "string" || payload.aud !== (config.allowedAudience ?? DEFAULT_ALLOWED_AUDIENCE)) return undefined;
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return undefined;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return undefined;
  if (payload.email_verified !== true) return undefined;
  if (typeof payload.email !== "string" || payload.email.length === 0) return undefined;
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return undefined;
  const email = payload.email.toLowerCase();
  const domainAllowed = config.allowedEmailDomains.some((domain) => email.endsWith(`@${domain.toLowerCase()}`));
  const exactAllowed = config.allowedEmails.some((allowed) => allowed.toLowerCase() === email);
  if (!domainAllowed && !exactAllowed) return undefined;

  let jwk: Jwk | undefined;
  try {
    jwk = await resolveSigningKey(config.jwksUrl ?? DEFAULT_JWKS_URL, header.kid);
  } catch {
    return undefined;
  }
  if (jwk === undefined) return undefined;

  let publicKey;
  try {
    publicKey = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" });
  } catch {
    return undefined;
  }

  let signatureValid: boolean;
  try {
    signatureValid = verify(
      "RSA-SHA256",
      Buffer.from(`${headerSegment}.${payloadSegment}`, "utf8"),
      publicKey,
      Buffer.from(signatureSegment, "base64url"),
    );
  } catch {
    // node:crypto's verify() is documented to return a boolean, but malformed/
    // implausible-length signature bytes have been known to throw a native
    // OpenSSL exception instead across some Node/OpenSSL version combinations.
    // signatureSegment is fully attacker-controlled and only checked for
    // non-zero length above — never let that reach the caller as an uncaught
    // exception (which would 500 instead of 401 through server.ts's onRequest
    // hook); it's just another way to fail verification.
    return undefined;
  }
  if (!signatureValid) return undefined;

  return { email: payload.email, sub: payload.sub };
}
