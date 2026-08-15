import { createServer, type Server } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import type { GoogleAuthConfig } from "../../src/index.js";

const TEST_KID = "test-key-1";
const TEST_AUDIENCE = "cipherpol-control-plane-test";
const TEST_EMAIL_DOMAIN = "mekari.com";

/**
 * A self-generated RSA keypair standing in for Google's real signing keys, plus
 * a tiny local HTTP server serving it as a JWKS document (the exact shape
 * `google-auth.ts`'s `fetchJwks` expects from `https://www.googleapis.com/oauth2/v3/certs`).
 * Every control-plane test that needs an authenticated request should call
 * `startTestGoogleAuth(t)` once and reuse the returned `config`/`mintToken` for
 * every `buildServer(...)` call and every signed request in that test.
 *
 * This is a synthetic signer exercising the exact real verification code path
 * (RS256, JWK import via `node:crypto`, issuer/audience/expiry/email_verified/
 * domain checks) — it does not call Google's network. A separate, one-off
 * manual check against a real `gcloud auth print-identity-token` output
 * confirmed `verifyGoogleIdToken` also accepts/rejects real Google-signed
 * tokens correctly; that real-network check is not repeatable in CI (there is
 * no live Google session available there), hence this local JWKS stand-in.
 */
export interface TestGoogleAuth {
  readonly config: GoogleAuthConfig;
  readonly mintToken: (overrides?: Partial<TestTokenClaims>, headerOverrides?: Partial<TestTokenHeader>) => string;
  readonly mintRaw: (payload: unknown, headerOverrides?: Partial<TestTokenHeader>) => string;
  readonly close: () => Promise<void>;
}

export interface TestTokenClaims {
  readonly iss: string;
  readonly aud: string;
  readonly email: string;
  readonly email_verified: boolean;
  readonly sub: string;
  readonly exp: number;
}

/** Overrides for the JWT header — used only to construct adversarial tokens (e.g. algorithm confusion) in tests. */
export interface TestTokenHeader {
  readonly alg: string;
  readonly kid: string;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Starts a local JWKS server and returns everything a test needs to build an
 * authenticated `buildServer(...)` instance and mint valid/invalid bearer
 * tokens. Always call this from `t.after`-guarded test setup so the server
 * closes even if the test throws.
 */
export async function startTestGoogleAuth(context: TestContext): Promise<TestGoogleAuth> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string; kty: string };

  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      keys: [{ kty: jwk.kty, n: jwk.n, e: jwk.e, kid: TEST_KID, alg: "RS256", use: "sig" }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const jwksUrl = `http://127.0.0.1:${port}/certs`;
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const config: GoogleAuthConfig = {
    allowedEmailDomains: [TEST_EMAIL_DOMAIN],
    allowedEmails: [],
    jwksUrl,
    allowedAudience: TEST_AUDIENCE,
  };

  function mintToken(overrides: Partial<TestTokenClaims> = {}, headerOverrides: Partial<TestTokenHeader> = {}): string {
    const claims: TestTokenClaims = {
      iss: "https://accounts.google.com",
      aud: TEST_AUDIENCE,
      email: `test-user-${Date.now()}-${Math.random().toString(36).slice(2)}@${TEST_EMAIL_DOMAIN}`,
      email_verified: true,
      sub: "110000000000000000000",
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    };
    const header = base64Url(JSON.stringify({ alg: "RS256", kid: TEST_KID, typ: "JWT", ...headerOverrides }));
    const payload = base64Url(JSON.stringify(claims));
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`, "utf8"), privateKey).toString("base64url");
    return `${header}.${payload}.${signature}`;
  }

  /** Signs an arbitrary (possibly deliberately malformed) payload with the test key, for claim-check edge cases that mintToken's fixed defaults can't express. */
  function mintRaw(payload: unknown, headerOverrides: Partial<TestTokenHeader> = {}): string {
    const header = base64Url(JSON.stringify({ alg: "RS256", kid: TEST_KID, typ: "JWT", ...headerOverrides }));
    const encodedPayload = base64Url(JSON.stringify(payload));
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${encodedPayload}`, "utf8"), privateKey).toString("base64url");
    return `${header}.${encodedPayload}.${signature}`;
  }

  return {
    config,
    mintToken,
    mintRaw,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Convenience: an `Authorization` header value for a freshly minted valid token. */
export function bearerHeader(auth: TestGoogleAuth, overrides?: Partial<TestTokenClaims>): string {
  return `Bearer ${auth.mintToken(overrides)}`;
}
