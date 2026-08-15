import assert from "node:assert/strict";
import test from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildServer, getCurrentSnapshot } from "../src/index.js";
import type { ControlPlaneTrustConfig } from "../src/index.js";
import { bearerHeader, startTestGoogleAuth } from "./helpers/google-auth.js";
import { buildSignedClosureFixture, cleanupFixtureRows, trustConfigFromFixture, uniqueSuffix } from "./helpers/signed-closure.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

  test("recording a review with a valid Google session succeeds and is listable", async (t) => {
    const auth = await startTestGoogleAuth(t);
    const suffix = uniqueSuffix();
    const channel = uniqueChannel();
    const fixture = await buildSignedClosureFixture(t, { suffix });
    const reviewerEmail = "reviewer@mekari.com";
    const app = buildServer(client, trustConfigFromFixture(fixture), auth.config);
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
      headers: { authorization: bearerHeader(auth) },
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
      headers: { authorization: bearerHeader(auth, { email: reviewerEmail }) },
      payload: { decision: "approved", comment: "looks good" },
    });
    assert.equal(reviewResponse.statusCode, 201);
    const reviewBody = reviewResponse.json() as { id: string };
    assert.ok(reviewBody.id.length > 0);

    const listResponse = await app.inject({
      method: "GET",
      url: `/generations/${snapshotId}/reviews`,
      headers: { authorization: bearerHeader(auth) },
    });
    assert.equal(listResponse.statusCode, 200);
    const reviews = listResponse.json() as Array<{
      snapshotId: string;
      reviewerEmail: string;
      decision: string;
      comment: string | null;
    }>;
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]?.snapshotId, snapshotId);
    assert.equal(reviews[0]?.reviewerEmail, reviewerEmail);
    assert.equal(reviews[0]?.decision, "approved");
    assert.equal(reviews[0]?.comment, "looks good");
  });

  test("recording a review without a Google session returns 401", async (t) => {
    const auth = await startTestGoogleAuth(t);
    const app = buildServer(client, dummyTrust, auth.config);
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/generations/00000000-0000-4000-8000-000000000000/reviews",
      payload: { decision: "approved" },
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), {
      code: "UNAUTHENTICATED",
      message: "A valid Google account session is required",
    });
  });

  test("recording a review against an unknown snapshotId returns 404", async (t) => {
    const auth = await startTestGoogleAuth(t);
    const app = buildServer(client, dummyTrust, auth.config);
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/generations/00000000-0000-4000-8000-000000000000/reviews",
      headers: { authorization: bearerHeader(auth) },
      payload: { decision: "rejected", comment: "nope" },
    });
    assert.equal(response.statusCode, 404);
  });

  test("ingest records published_by from the authenticated Google identity", async (t) => {
    const auth = await startTestGoogleAuth(t);
    const suffix = uniqueSuffix();
    const channel = uniqueChannel();
    const publisherEmail = "publisher@mekari.com";
    const fixture = await buildSignedClosureFixture(t, { suffix });
    const app = buildServer(client, trustConfigFromFixture(fixture), auth.config);
    t.after(async () => {
      await app.close();
      await cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] });
    });

    const response = await app.inject({
      method: "POST",
      url: "/registry/ingest",
      headers: { authorization: bearerHeader(auth, { email: publisherEmail }) },
      payload: {
        registryEnvelope: fixture.registryEnvelope,
        admissionEnvelopes: fixture.admissionEnvelopes,
        channel,
      },
    });
    assert.equal(response.statusCode, 201);
    const snapshot = await getCurrentSnapshot(client, channel);
    assert.equal(snapshot?.publishedBy, publisherEmail);
  });

  test("ingest without any Authorization header is rejected with 401, not silently anonymous", async (t) => {
    const auth = await startTestGoogleAuth(t);
    const fixture = await buildSignedClosureFixture(t);
    const channel = uniqueChannel();
    const app = buildServer(client, trustConfigFromFixture(fixture), auth.config);
    t.after(async () => {
      await app.close();
      await cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] });
    });

    const response = await app.inject({
      method: "POST",
      url: "/registry/ingest",
      payload: {
        registryEnvelope: fixture.registryEnvelope,
        admissionEnvelopes: fixture.admissionEnvelopes,
        channel,
      },
    });
    assert.equal(response.statusCode, 401);

    // Confirm nothing was actually ingested — the rejection must be genuine,
    // not a false-positive 401 alongside a real write.
    const snapshot = await getCurrentSnapshot(client, channel);
    assert.equal(snapshot, undefined);
  });

  test("ingest with a garbage/invalid Bearer token is rejected with 401, never mistaken for a valid session", async (t) => {
    const auth = await startTestGoogleAuth(t);
    const fixture = await buildSignedClosureFixture(t);
    const channel = uniqueChannel();
    const app = buildServer(client, trustConfigFromFixture(fixture), auth.config);
    t.after(async () => {
      await app.close();
      await cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] });
    });

    const response = await app.inject({
      method: "POST",
      url: "/registry/ingest",
      headers: { authorization: "Bearer not-a-real-jwt" },
      payload: {
        registryEnvelope: fixture.registryEnvelope,
        admissionEnvelopes: fixture.admissionEnvelopes,
        channel,
      },
    });
    assert.equal(response.statusCode, 401);
    const snapshot = await getCurrentSnapshot(client, channel);
    assert.equal(snapshot, undefined);
  });
}
