import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifySessionToken } from "../src/index.js";

const SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const USER_ID = "11111111-2222-4333-8444-555555555555";

/**
 * Mints a real HS256 JWT signed with the given secret — the same shape Supabase
 * Auth (GoTrue) issues. Tests exercise `verifySessionToken`'s actual HMAC
 * verification, not a stub. Defaults `role`/`aud` to the genuine Supabase
 * authenticated-user-session values so every call site produces an otherwise-valid
 * token unless a test deliberately overrides one of these fields to exercise
 * rejection of a non-user-session token that happens to share the same secret.
 */
function mintJwt(secret: string, payload: Record<string, unknown>): string {
  const merged = { role: "authenticated", aud: "authenticated", ...payload };
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString("base64url");
  const body = Buffer.from(JSON.stringify(merged), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

test("accepts a valid token and returns its sub claim as userId", () => {
  const token = mintJwt(SECRET, { sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 });
  assert.deepEqual(verifySessionToken(SECRET, `Bearer ${token}`), { userId: USER_ID });
});

test("rejects a token signed with a different secret", () => {
  const wrongSecret = "another-secret-token-with-at-least-32-characters";
  const token = mintJwt(wrongSecret, { sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal(verifySessionToken(SECRET, `Bearer ${token}`), undefined);
});

test("rejects a token whose signature was made for different content", () => {
  const token = mintJwt(SECRET, { sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 });
  const [header, , signature] = token.split(".");
  const tampered = `${header}.${Buffer.from(JSON.stringify({ sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 7200 }), "utf8").toString("base64url")}.${signature}`;
  assert.equal(verifySessionToken(SECRET, `Bearer ${tampered}`), undefined);
});

test("rejects an expired token", () => {
  const token = mintJwt(SECRET, { sub: USER_ID, exp: Math.floor(Date.now() / 1000) - 60 });
  assert.equal(verifySessionToken(SECRET, `Bearer ${token}`), undefined);
});

test("rejects a malformed Authorization header", () => {
  const token = mintJwt(SECRET, { sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal(verifySessionToken(SECRET, token), undefined, "missing 'Bearer ' prefix");
  assert.equal(verifySessionToken(SECRET, `Basic ${token}`), undefined, "wrong scheme");
  assert.equal(verifySessionToken(SECRET, "Bearer"), undefined, "no token after scheme");
  assert.equal(verifySessionToken(SECRET, "Bearer not-a-jwt"), undefined, "not three segments");
});

test("returns undefined without throwing when the secret or header is missing", () => {
  const token = mintJwt(SECRET, { sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal(verifySessionToken(undefined, `Bearer ${token}`), undefined);
  assert.equal(verifySessionToken(SECRET, undefined), undefined);
  assert.equal(verifySessionToken(undefined, undefined), undefined);
});

test("rejects a token whose role/aud claims are not the authenticated-user-session values", () => {
  const wrongRole = mintJwt(SECRET, { sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600, role: "service_role" });
  assert.equal(verifySessionToken(SECRET, `Bearer ${wrongRole}`), undefined, "wrong role claim");
  const wrongAud = mintJwt(SECRET, { sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 3600, aud: "anon" });
  assert.equal(verifySessionToken(SECRET, `Bearer ${wrongAud}`), undefined, "wrong aud claim");
});
