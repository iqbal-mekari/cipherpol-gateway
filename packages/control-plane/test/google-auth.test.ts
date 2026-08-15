import assert from "node:assert/strict";
import test from "node:test";
import { verifyGoogleIdToken } from "../src/index.js";
import { startTestGoogleAuth } from "./helpers/google-auth.js";

test("accepts a validly signed token for the allowed email domain", async (t) => {
  const auth = await startTestGoogleAuth(t);
  const token = auth.mintToken({ email: "engineer@mekari.com" });
  const identity = await verifyGoogleIdToken(auth.config, `Bearer ${token}`);
  assert.deepEqual(identity, { email: "engineer@mekari.com", sub: "110000000000000000000" });
});

test("rejects a validly signed token for a different email domain", async (t) => {
  const auth = await startTestGoogleAuth(t);
  const token = auth.mintToken({ email: "someone@gmail.com" });
  const identity = await verifyGoogleIdToken(auth.config, `Bearer ${token}`);
  assert.equal(identity, undefined);
});

test("rejects a token whose signature was made for different content", async (t) => {
  const auth = await startTestGoogleAuth(t);
  const token = auth.mintToken({ email: "engineer@mekari.com" });
  const [header, , signature] = token.split(".");
  const tamperedPayload = Buffer.from(JSON.stringify({
    iss: "https://accounts.google.com",
    aud: "cipherpol-control-plane-test",
    email: "attacker@mekari.com",
    email_verified: true,
    sub: "999",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString("base64url");
  const tampered = `${header}.${tamperedPayload}.${signature}`;
  const identity = await verifyGoogleIdToken(auth.config, `Bearer ${tampered}`);
  assert.equal(identity, undefined, "swapping the payload after signing must invalidate the signature");
});

test("rejects an expired token", async (t) => {
  const auth = await startTestGoogleAuth(t);
  const token = auth.mintToken({ email: "engineer@mekari.com", exp: Math.floor(Date.now() / 1000) - 60 });
  const identity = await verifyGoogleIdToken(auth.config, `Bearer ${token}`);
  assert.equal(identity, undefined);
});

test("rejects a token with email_verified: false", async (t) => {
  const auth = await startTestGoogleAuth(t);
  const token = auth.mintToken({ email: "engineer@mekari.com", email_verified: false });
  const identity = await verifyGoogleIdToken(auth.config, `Bearer ${token}`);
  assert.equal(identity, undefined);
});

test("rejects a token with the wrong audience", async (t) => {
  const auth = await startTestGoogleAuth(t);
  const token = auth.mintToken({ email: "engineer@mekari.com", aud: "some-other-service" });
  const identity = await verifyGoogleIdToken(auth.config, `Bearer ${token}`);
  assert.equal(identity, undefined);
});

test("rejects a token with the wrong issuer", async (t) => {
  const auth = await startTestGoogleAuth(t);
  const token = auth.mintToken({ email: "engineer@mekari.com", iss: "https://not-google.example" });
  const identity = await verifyGoogleIdToken(auth.config, `Bearer ${token}`);
  assert.equal(identity, undefined);
});

test("rejects a malformed Authorization header", async (t) => {
  const auth = await startTestGoogleAuth(t);
  const token = auth.mintToken({ email: "engineer@mekari.com" });
  assert.equal(await verifyGoogleIdToken(auth.config, token), undefined, "missing 'Bearer ' prefix");
  assert.equal(await verifyGoogleIdToken(auth.config, `Basic ${token}`), undefined, "wrong scheme");
  assert.equal(await verifyGoogleIdToken(auth.config, "Bearer"), undefined, "no token after scheme");
  assert.equal(await verifyGoogleIdToken(auth.config, "Bearer not-a-jwt"), undefined, "not three segments");
});

test("returns undefined without throwing when the header is missing", async (t) => {
  const auth = await startTestGoogleAuth(t);
  assert.equal(await verifyGoogleIdToken(auth.config, undefined), undefined);
});

test("re-fetches the JWKS exactly once when a kid is unknown, and still rejects if it remains unknown", async (t) => {
  const auth = await startTestGoogleAuth(t);
  const token = auth.mintToken({ email: "engineer@mekari.com" });
  const [, payload, signature] = token.split(".");
  const badHeader = Buffer.from(JSON.stringify({ alg: "RS256", kid: "never-existed", typ: "JWT" })).toString("base64url");
  const identity = await verifyGoogleIdToken(auth.config, `Bearer ${badHeader}.${payload}.${signature}`);
  assert.equal(identity, undefined);
});

test("case-insensitively matches the allowed email domain", async (t) => {
  const auth = await startTestGoogleAuth(t);
  const token = auth.mintToken({ email: "Engineer@Mekari.COM" });
  const identity = await verifyGoogleIdToken(auth.config, `Bearer ${token}`);
  assert.ok(identity !== undefined);
});

test("rejects a token whose header claims a non-RS256 algorithm, even though it is genuinely RSA-signed", async (t) => {
  const auth = await startTestGoogleAuth(t);
  const token = auth.mintToken({ email: "engineer@mekari.com" }, { alg: "HS256" });
  const identity = await verifyGoogleIdToken(auth.config, `Bearer ${token}`);
  assert.equal(
    identity,
    undefined,
    "a non-RS256 alg must be rejected outright, never trusted to select a different verification path",
  );
});

test("rejects a token whose header claims alg: none", async (t) => {
  const auth = await startTestGoogleAuth(t);
  const token = auth.mintToken({ email: "engineer@mekari.com" }, { alg: "none" });
  const identity = await verifyGoogleIdToken(auth.config, `Bearer ${token}`);
  assert.equal(identity, undefined);
});

test("rejects domain-boundary-collision emails that would defeat a naive substring/prefix check", async (t) => {
  const auth = await startTestGoogleAuth(t);
  // `email` is a Google-signed, Google-attested claim — an attacker cannot
  // forge its value without breaking the RS256 signature — so this test is
  // about the *matching logic's* correctness for genuinely-issued emails
  // whose domain happens to superficially resemble the allowed one, not
  // about untrusted-input parsing. `attacker@evil.com@mekari.com` is
  // deliberately excluded: it genuinely ends with "@mekari.com" (the domain
  // suffix a real mekari.com-issued token would also end with), so accepting
  // it is correct string-matching behavior, not a bypass.
  for (const email of [
    "attacker@evilmekari.com",
    "attacker@notmekari.com",
    "attacker@mekari.com.evil.com",
  ]) {
    const token = auth.mintToken({ email });
    const identity = await verifyGoogleIdToken(auth.config, `Bearer ${token}`);
    assert.equal(identity, undefined, `expected rejection for crafted email: ${email}`);
  }
});

test("rejects a token whose header (kid) was tampered with while payload/signature are untouched", async (t) => {
  const auth = await startTestGoogleAuth(t);
  const token = auth.mintToken({ email: "engineer@mekari.com" });
  const [, payload, signature] = token.split(".");
  const tamperedHeader = Buffer.from(JSON.stringify({ alg: "RS256", kid: "a-different-kid", typ: "JWT" })).toString("base64url");
  const identity = await verifyGoogleIdToken(auth.config, `Bearer ${tamperedHeader}.${payload}.${signature}`);
  assert.equal(identity, undefined);
});

test("rejects a malformed/too-short signature segment without throwing", async (t) => {
  const auth = await startTestGoogleAuth(t);
  const token = auth.mintToken({ email: "engineer@mekari.com" });
  const [header, payload] = token.split(".");
  await assert.doesNotReject(async () => {
    const identity = await verifyGoogleIdToken(auth.config, `Bearer ${header}.${payload}.AA`);
    assert.equal(identity, undefined);
  });
});

test("accepts the issuer without a scheme and rejects one with a trailing slash", async (t) => {
  const auth = await startTestGoogleAuth(t);
  const schemeLess = auth.mintToken({ iss: "accounts.google.com" });
  assert.ok((await verifyGoogleIdToken(auth.config, `Bearer ${schemeLess}`)) !== undefined);
  const trailingSlash = auth.mintToken({ iss: "https://accounts.google.com/" });
  assert.equal(await verifyGoogleIdToken(auth.config, `Bearer ${trailingSlash}`), undefined);
});

test("rejects an audience supplied as a JSON array", async (t) => {
  const auth = await startTestGoogleAuth(t);
  const token = auth.mintRaw({ iss: "https://accounts.google.com", aud: ["cipherpol-control-plane-test"], email: "engineer@mekari.com", email_verified: true, sub: "110000000000000000000", exp: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal(await verifyGoogleIdToken(auth.config, `Bearer ${token}`), undefined);
});

test("rejects tokens missing exp, sub, or email", async (t) => {
  const auth = await startTestGoogleAuth(t);
  const base = { iss: "https://accounts.google.com", aud: "cipherpol-control-plane-test", email_verified: true } as const;
  const missingExp = auth.mintRaw({ ...base, email: "engineer@mekari.com", sub: "110000000000000000000" });
  assert.equal(await verifyGoogleIdToken(auth.config, `Bearer ${missingExp}`), undefined, "missing exp");
  const missingSub = auth.mintRaw({ ...base, email: "engineer@mekari.com", exp: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal(await verifyGoogleIdToken(auth.config, `Bearer ${missingSub}`), undefined, "missing sub");
  const missingEmail = auth.mintRaw({ ...base, sub: "110000000000000000000", exp: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal(await verifyGoogleIdToken(auth.config, `Bearer ${missingEmail}`), undefined, "missing email");
});

test("rejects a non-numeric exp claim", async (t) => {
  const auth = await startTestGoogleAuth(t);
  const token = auth.mintRaw({ iss: "https://accounts.google.com", aud: "cipherpol-control-plane-test", email: "engineer@mekari.com", email_verified: true, sub: "110000000000000000000", exp: "soon" });
  assert.equal(await verifyGoogleIdToken(auth.config, `Bearer ${token}`), undefined);
});

test("rejects PS256/ES256/EdDSA header algorithms even if signed with RSA", async (t) => {
  const auth = await startTestGoogleAuth(t);
  for (const alg of ["PS256", "ES256", "EdDSA"]) {
    const token = auth.mintToken({ email: "engineer@mekari.com" }, { alg });
    assert.equal(await verifyGoogleIdToken(auth.config, `Bearer ${token}`), undefined, `expected rejection for alg ${alg}`);
  }
});
