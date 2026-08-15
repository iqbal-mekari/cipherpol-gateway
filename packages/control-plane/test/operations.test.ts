import assert from "node:assert/strict";
import test from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildServer, ingestClosure, listIngestHistory } from "../src/index.js";
import type { ControlPlaneTrustConfig } from "../src/index.js";
import { buildSignedClosureFixture, cleanupFixtureRows, trustConfigFromFixture, uniqueSuffix } from "./helpers/signed-closure.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  test.skip("operations.test.ts requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (skipping — no live Supabase instance configured)", () => {});
} else {
  const client: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // The health/history routes never read any of these trust fields, but
  // `buildServer` requires a well-formed config; mirror projects.test.ts.
  const trust: ControlPlaneTrustConfig = {
    trustedKeyId: "unused",
    trustedPublicKeyPem: "unused",
    trustedKeyPurpose: "fixture",
    allowFixtureKeys: true,
  };

  // A client pointed at a port nothing listens on — must be constructed lazily
  // (no network until a query) so `/health` can prove it never touches it.
  const unreachableClient: SupabaseClient = createClient("http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  function uniqueChannel(): string {
    return `ops-test-${uniqueSuffix()}`;
  }

  test("GET /health returns 200 { status: ok } even when the client points at an unreachable URL", async (t) => {
    const app = buildServer(unreachableClient, trust);
    t.after(() => app.close());

    const response = await app.inject({ method: "GET", url: "/health" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: "ok" });
  });

  test("GET /health/ready returns 200 against the live instance and 503 against an unreachable client", async (t) => {
    const liveApp = buildServer(client, trust);
    t.after(() => liveApp.close());

    const ready = await liveApp.inject({ method: "GET", url: "/health/ready" });
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(ready.json(), { status: "ready" });

    const deadApp = buildServer(unreachableClient, trust);
    t.after(() => deadApp.close());

    const notReady = await deadApp.inject({ method: "GET", url: "/health/ready" });
    assert.equal(notReady.statusCode, 503);
    assert.deepEqual(notReady.json(), { status: "not_ready" });
  });

  test("listIngestHistory returns newest-first metadata and never the envelope blobs", async (t) => {
    const channel = uniqueChannel();
    const first = await buildSignedClosureFixture(t);
    const second = await buildSignedClosureFixture(t);
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [first.packageId, second.packageId] }));

    const firstResult = await ingestClosure(client, trustConfigFromFixture(first), {
      registryEnvelope: first.registryEnvelope,
      admissionEnvelopes: first.admissionEnvelopes,
      channel,
    });
    const secondResult = await ingestClosure(client, trustConfigFromFixture(second), {
      registryEnvelope: second.registryEnvelope,
      admissionEnvelopes: second.admissionEnvelopes,
      channel,
    });

    const history = await listIngestHistory(client, { channel });
    assert.equal(history.length, 2);
    const [newest, oldest] = history;
    assert.ok(newest !== undefined && oldest !== undefined);
    // Newest-first: the second ingest supersedes and precedes the first.
    assert.equal(newest.id, secondResult.snapshotId);
    assert.equal(oldest.id, firstResult.snapshotId);

    for (const entry of history) {
      assert.equal(entry.channel, channel);
      assert.ok(!("registry_envelope" in entry), "registry_envelope must not be present in the payload");
      assert.ok(!("admission_envelopes" in entry), "admission_envelopes must not be present in the payload");
      assert.equal(entry.sourceRevision, first.closureManifest.sourceRevision);
      assert.equal(entry.keyId, first.keyId);
      assert.ok(entry.ingestedAt.length > 0);
    }
    // The superseded snapshot carries its superseded_at; the current one does not.
    assert.notEqual(oldest.supersededAt, null);
    assert.equal(newest.supersededAt, undefined);
  });

  test("GET /registry/ingest-history respects the channel filter and omits envelope blobs over HTTP", async (t) => {
    const channelA = uniqueChannel();
    const channelB = uniqueChannel();
    const fixtureA = await buildSignedClosureFixture(t);
    const fixtureB = await buildSignedClosureFixture(t);
    t.after(() =>
      cleanupFixtureRows(client, {
        channels: [channelA, channelB],
        packageIds: [fixtureA.packageId, fixtureB.packageId],
      }),
    );

    const resultA = await ingestClosure(client, trustConfigFromFixture(fixtureA), {
      registryEnvelope: fixtureA.registryEnvelope,
      admissionEnvelopes: fixtureA.admissionEnvelopes,
      channel: channelA,
    });
    const resultB = await ingestClosure(client, trustConfigFromFixture(fixtureB), {
      registryEnvelope: fixtureB.registryEnvelope,
      admissionEnvelopes: fixtureB.admissionEnvelopes,
      channel: channelB,
    });

    const app = buildServer(client, trust);
    t.after(() => app.close());

    const filtered = await app.inject({ method: "GET", url: "/registry/ingest-history", query: { channel: channelA } });
    assert.equal(filtered.statusCode, 200);
    const filteredBody = filtered.json() as Array<Record<string, unknown>>;
    assert.ok(filteredBody.length >= 1);
    assert.ok(filteredBody.every((entry) => entry.channel === channelA));
    assert.ok(filteredBody.some((entry) => entry.id === resultA.snapshotId));
    assert.ok(!filteredBody.some((entry) => entry.id === resultB.snapshotId));
    for (const entry of filteredBody) {
      assert.ok(!("registry_envelope" in entry));
      assert.ok(!("admission_envelopes" in entry));
    }

    const unfiltered = await app.inject({ method: "GET", url: "/registry/ingest-history" });
    assert.equal(unfiltered.statusCode, 200);
    const unfilteredBody = unfiltered.json() as Array<{ id: string }>;
    assert.ok(unfilteredBody.some((entry) => entry.id === resultA.snapshotId));
    assert.ok(unfilteredBody.some((entry) => entry.id === resultB.snapshotId));
  });
}
