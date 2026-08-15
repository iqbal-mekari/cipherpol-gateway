import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildServer, getCurrentSnapshot } from "../src/index.js";
import type { ControlPlaneTrustConfig } from "../src/index.js";
import { buildSignedClosureFixture, cleanupFixtureRows, trustConfigFromFixture, uniqueSuffix } from "./helpers/signed-closure.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";

/** Mints a real HS256 session token for a Supabase-shaped `sub`/`exp` payload. */
function mintJwt(secret: string, payload: Record<string, unknown>): string {
  const merged = { role: "authenticated", aud: "authenticated", ...payload };
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8").toString("base64url");
  const body = Buffer.from(JSON.stringify(merged), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

function sessionFor(userId: string): string {
  return mintJwt(JWT_SECRET, { sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 });
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  test.skip("reviews.test.ts requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (skipping — no live Supabase instance configured)", () => {});
} else {
  const client: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // The review routes never read the trust config (only the ingest route does),
  // so a dummy config is enough for tests that don't ingest a closure.
  const dummyTrust: ControlPlaneTrustConfig = {
    trustedKeyId: "unused",
    trustedPublicKeyPem: "unused",
    trustedKeyPurpose: "fixture",
    allowFixtureKeys: true,
  };

  function uniqueChannel(): string {
    return `reviews-test-${uniqueSuffix()}`;
  }

  test("recording a review with a valid session succeeds and is listable", async (t) => {
    const suffix = uniqueSuffix();
    const channel = uniqueChannel();
    const fixture = await buildSignedClosureFixture(t, { suffix });
    const reviewerUserId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const app = buildServer(client, trustConfigFromFixture(fixture), { jwtSecret: JWT_SECRET });
    let snapshotId: string | undefined;
    t.after(async () => {
      await app.close();
      if (snapshotId !== undefined) {
        await client.from("snapshot_reviews").delete().eq("snapshot_id", snapshotId);
      }
      await cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] });
    });

    const ingestResponse = await app.inject({
      method: "POST",
      url: "/registry/ingest",
      payload: {
        registryEnvelope: fixture.registryEnvelope,
        admissionEnvelopes: fixture.admissionEnvelopes,
        channel,
      },
    });
    assert.equal(ingestResponse.statusCode, 201);
    snapshotId = (ingestResponse.json() as { snapshotId: string }).snapshotId;

    const reviewResponse = await app.inject({
      method: "POST",
      url: `/generations/${snapshotId}/reviews`,
      headers: { authorization: `Bearer ${sessionFor(reviewerUserId)}` },
      payload: { decision: "approved", comment: "looks good" },
    });
    assert.equal(reviewResponse.statusCode, 201);
    const reviewBody = reviewResponse.json() as { id: string };
    assert.ok(reviewBody.id.length > 0);

    const listResponse = await app.inject({ method: "GET", url: `/generations/${snapshotId}/reviews` });
    assert.equal(listResponse.statusCode, 200);
    const reviews = listResponse.json() as Array<{
      snapshotId: string;
      reviewerUserId: string;
      decision: string;
      comment: string | null;
    }>;
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]?.snapshotId, snapshotId);
    assert.equal(reviews[0]?.reviewerUserId, reviewerUserId);
    assert.equal(reviews[0]?.decision, "approved");
    assert.equal(reviews[0]?.comment, "looks good");
  });

  test("recording a review without a session returns 401", async (t) => {
    const app = buildServer(client, dummyTrust, { jwtSecret: JWT_SECRET });
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/generations/00000000-0000-4000-8000-000000000000/reviews",
      payload: { decision: "approved" },
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), {
      code: "UNAUTHENTICATED",
      message: "A valid session is required to record a review",
    });
  });

  test("recording a review against an unknown snapshotId returns 404", async (t) => {
    const app = buildServer(client, dummyTrust, { jwtSecret: JWT_SECRET });
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/generations/00000000-0000-4000-8000-000000000000/reviews",
      headers: { authorization: `Bearer ${sessionFor("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff")}` },
      payload: { decision: "rejected", comment: "nope" },
    });
    assert.equal(response.statusCode, 404);
  });

  test("ingest records published_by when authorized, and leaves it undefined otherwise", async (t) => {
    const suffix = uniqueSuffix();
    const channel = uniqueChannel();
    const publisherUserId = "cccccccc-dddd-4eee-8fff-000000000000";
    const fixture = await buildSignedClosureFixture(t, { suffix });
    const app = buildServer(client, trustConfigFromFixture(fixture), { jwtSecret: JWT_SECRET });
    t.after(async () => {
      await app.close();
      await cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] });
    });

    const authorizedResponse = await app.inject({
      method: "POST",
      url: "/registry/ingest",
      headers: { authorization: `Bearer ${sessionFor(publisherUserId)}` },
      payload: {
        registryEnvelope: fixture.registryEnvelope,
        admissionEnvelopes: fixture.admissionEnvelopes,
        channel,
      },
    });
    assert.equal(authorizedResponse.statusCode, 201);
    const authorizedSnapshot = await getCurrentSnapshot(client, channel);
    assert.equal(authorizedSnapshot?.publishedBy, publisherUserId);

    // A second channel, ingested without any Authorization header, must still
    // succeed and simply leave published_by unset.
    const anonymousChannel = uniqueChannel();
    t.after(() => cleanupFixtureRows(client, { channels: [anonymousChannel], packageIds: [fixture.packageId] }));
    const anonymousResponse = await app.inject({
      method: "POST",
      url: "/registry/ingest",
      payload: {
        registryEnvelope: fixture.registryEnvelope,
        admissionEnvelopes: fixture.admissionEnvelopes,
        channel: anonymousChannel,
      },
    });
    assert.equal(anonymousResponse.statusCode, 201);
    const anonymousSnapshot = await getCurrentSnapshot(client, anonymousChannel);
    assert.equal(anonymousSnapshot?.publishedBy, undefined);

    // A third channel, ingested with a garbage/invalid Bearer token, must be
    // treated exactly like "no header" — silently unauthenticated, never a 500
    // and never mistaken for a valid session.
    const invalidTokenChannel = uniqueChannel();
    t.after(() => cleanupFixtureRows(client, { channels: [invalidTokenChannel], packageIds: [fixture.packageId] }));
    const invalidTokenResponse = await app.inject({
      method: "POST",
      url: "/registry/ingest",
      headers: { authorization: "Bearer not-a-real-jwt" },
      payload: {
        registryEnvelope: fixture.registryEnvelope,
        admissionEnvelopes: fixture.admissionEnvelopes,
        channel: invalidTokenChannel,
      },
    });
    assert.equal(invalidTokenResponse.statusCode, 201);
    const invalidTokenSnapshot = await getCurrentSnapshot(client, invalidTokenChannel);
    assert.equal(invalidTokenSnapshot?.publishedBy, undefined);
  });
}
