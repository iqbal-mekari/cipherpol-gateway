import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadControlPlaneEnv } from "../src/index.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const trustedPublicKeyPem = readFileSync(
  join(repoRoot, "fixtures/software-dev-agentic/stage2-fixture-public.pem"),
  "utf8",
);

const validTrustEnv = {
  CONTROL_PLANE_TRUSTED_KEY_ID: "fixture.stage2.software-dev-agentic",
  CONTROL_PLANE_TRUSTED_PUBLIC_KEY_PEM: trustedPublicKeyPem,
  CONTROL_PLANE_TRUSTED_KEY_PURPOSE: "fixture",
  GOOGLE_AUTH_ALLOWED_EMAIL_DOMAINS: "mekari.com",
  GOOGLE_AUTH_ALLOWED_EMAILS: "",
};

test("requires explicit Supabase URL and service-role key", () => {
  assert.throws(
    () => loadControlPlaneEnv({}),
    (error: unknown) => error instanceof Error && /SUPABASE_URL/.test(error.message),
  );
});

test("rejects a new-format publishable key passed as the service-role key", () => {
  assert.throws(
    () => loadControlPlaneEnv({
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_abc123",
    }),
    (error: unknown) => error instanceof Error && /service-role/.test(error.message),
  );
});

test("rejects a legacy anon JWT passed as the service-role key", () => {
  const anonJwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url")}.sig`;
  assert.throws(
    () => loadControlPlaneEnv({
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: anonJwt,
    }),
    (error: unknown) => error instanceof Error && /service-role/.test(error.message),
  );
});

test("loads a valid new-format secret key", () => {
  const env = loadControlPlaneEnv({
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc123",
    PORT: "4100",
    ...validTrustEnv,
  });
  assert.equal(env.supabaseUrl, "http://127.0.0.1:54321");
  assert.equal(env.port, 4100);
});

test("loads a valid legacy service_role JWT", () => {
  const serviceRoleJwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.sig`;
  const env = loadControlPlaneEnv({
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleJwt,
    ...validTrustEnv,
  });
  assert.equal(env.supabaseServiceRoleKey, serviceRoleJwt);
  assert.equal(env.port, 4100);
});

test("accepts a trusted public key PEM base64-encoded on a single line, as required for systemd EnvironmentFile deployment", () => {
  const base64Pem = Buffer.from(trustedPublicKeyPem.trim(), "utf8").toString("base64");
  const env = loadControlPlaneEnv({
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc123",
    ...validTrustEnv,
    CONTROL_PLANE_TRUSTED_PUBLIC_KEY_PEM: base64Pem,
  });
  assert.equal(env.trustedPublicKeyPem, trustedPublicKeyPem.trim());
});

test("parses both Google auth allowlist variables into lowercase, trimmed, deduplicated-of-empties lists", () => {
  const env = loadControlPlaneEnv({
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc123",
    ...validTrustEnv,
    GOOGLE_AUTH_ALLOWED_EMAIL_DOMAINS: " Mekari.com ,, mekari.id ,",
    GOOGLE_AUTH_ALLOWED_EMAILS: " IqbalMineralTown@gmail.com ,, other@Example.com ",
  });
  assert.deepEqual(env.googleAuthAllowedEmailDomains, ["mekari.com", "mekari.id"]);
  assert.deepEqual(env.googleAuthAllowedEmails, ["iqbalmineraltown@gmail.com", "other@example.com"]);
});

test("allows only one of the two Google auth allowlist variables to be set", () => {
  const domainsOnly = loadControlPlaneEnv({
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc123",
    ...validTrustEnv,
    GOOGLE_AUTH_ALLOWED_EMAIL_DOMAINS: "mekari.com",
    GOOGLE_AUTH_ALLOWED_EMAILS: "",
  });
  assert.deepEqual(domainsOnly.googleAuthAllowedEmailDomains, ["mekari.com"]);
  assert.deepEqual(domainsOnly.googleAuthAllowedEmails, []);

  const emailsOnly = loadControlPlaneEnv({
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc123",
    ...validTrustEnv,
    GOOGLE_AUTH_ALLOWED_EMAIL_DOMAINS: "",
    GOOGLE_AUTH_ALLOWED_EMAILS: "iqbalmineraltown@gmail.com",
  });
  assert.deepEqual(emailsOnly.googleAuthAllowedEmailDomains, []);
  assert.deepEqual(emailsOnly.googleAuthAllowedEmails, ["iqbalmineraltown@gmail.com"]);
});

test("rejects a configuration where neither Google auth allowlist variable has an entry", () => {
  const { GOOGLE_AUTH_ALLOWED_EMAIL_DOMAINS: _domains, GOOGLE_AUTH_ALLOWED_EMAILS: _emails, ...rest } = validTrustEnv;
  assert.throws(
    () => loadControlPlaneEnv({
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc123",
      ...rest,
    }),
    (error: unknown) => error instanceof Error && /GOOGLE_AUTH_ALLOWED_EMAIL_DOMAINS/.test(error.message),
  );
});

test("requires the four trust configuration variables", () => {
  assert.throws(
    () => loadControlPlaneEnv({
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc123",
    }),
    (error: unknown) => (
      error instanceof Error
      && /CONTROL_PLANE_TRUSTED_KEY_ID/.test(error.message)
      && /CONTROL_PLANE_TRUSTED_PUBLIC_KEY_PEM/.test(error.message)
      && /CONTROL_PLANE_TRUSTED_KEY_PURPOSE/.test(error.message)
    ),
  );
});

test("rejects a trusted public key that is not a valid PEM-encoded Ed25519 key", () => {
  assert.throws(
    () => loadControlPlaneEnv({
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc123",
      ...validTrustEnv,
      CONTROL_PLANE_TRUSTED_PUBLIC_KEY_PEM: "not a pem at all",
    }),
    (error: unknown) => error instanceof Error && /Ed25519/.test(error.message),
  );
});

test("rejects an RSA public key as the trusted key", () => {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.throws(
    () => loadControlPlaneEnv({
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc123",
      ...validTrustEnv,
      CONTROL_PLANE_TRUSTED_PUBLIC_KEY_PEM: rsaPem,
    }),
    (error: unknown) => error instanceof Error && /Ed25519/.test(error.message),
  );
});

test("defaults allowFixtureKeys to false when unset", () => {
  const env = loadControlPlaneEnv({
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc123",
    ...validTrustEnv,
  });
  assert.equal(env.allowFixtureKeys, false);
});

test("parses an explicit allowFixtureKeys=true", () => {
  const env = loadControlPlaneEnv({
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc123",
    ...validTrustEnv,
    CONTROL_PLANE_ALLOW_FIXTURE_KEYS: "true",
  });
  assert.equal(env.allowFixtureKeys, true);
});

test("rejects a non-boolean-string allowFixtureKeys value", () => {
  assert.throws(
    () => loadControlPlaneEnv({
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abc123",
      ...validTrustEnv,
      CONTROL_PLANE_ALLOW_FIXTURE_KEYS: "yes",
    }),
    (error: unknown) => error instanceof Error && /CONTROL_PLANE_ALLOW_FIXTURE_KEYS/.test(error.message),
  );
});
