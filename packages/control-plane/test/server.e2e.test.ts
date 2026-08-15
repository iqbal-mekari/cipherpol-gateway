import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilityPack, CipherpolManifest } from "@cipherpol/contracts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildServer } from "../src/index.js";
import { buildSignedClosureFixture, cleanupFixtureRows, trustConfigFromFixture, uniqueSuffix } from "./helpers/signed-closure.js";
import { startTestGoogleAuth, bearerHeader } from "./helpers/google-auth.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  test.skip("server.e2e.test.ts requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (skipping — no live Supabase instance configured)", () => {});
} else {
  const client: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  function uniqueChannel(): string {
    return `server-e2e-test-${uniqueSuffix()}`;
  }

  test("full ingest → read → resolve happy path over HTTP", async (t) => {
    const auth = await startTestGoogleAuth(t);
    const suffix = uniqueSuffix();
    const channel = uniqueChannel();
    const capabilityPack: CapabilityPack = {
      id: `cipherpol-test-${suffix}/pack/dev`,
      version: "1.0.0",
      intents: ["dev"],
      platforms: ["generic"],
      orchestrator: `cipherpol-test-${suffix}/adapter/cp1@^2.0.0`,
      packages: [`cipherpol-test-${suffix}/adapter/cp1@^2.0.0`],
      playbooks: [],
      requiredEvidence: [],
      revoked: false,
    };
    const fixture = await buildSignedClosureFixture(t, { suffix, capabilityPacks: [capabilityPack] });
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId, capabilityPack.id] }));
    const app = buildServer(client, trustConfigFromFixture(fixture), auth.config);
    t.after(() => app.close());

    const ingestResponse = await app.inject({
      method: "POST",
      url: "/registry/ingest",
      payload: {
        registryEnvelope: fixture.registryEnvelope,
        admissionEnvelopes: fixture.admissionEnvelopes,
        channel,
      },
      headers: { authorization: bearerHeader(auth) },
    });
    assert.equal(ingestResponse.statusCode, 201);
    const ingestBody = ingestResponse.json() as { snapshotId: string };
    assert.ok(ingestBody.snapshotId.length > 0);

    const packagesResponse = await app.inject({
      method: "GET",
      url: `/registry/packages?channel=${channel}`,
      headers: { authorization: bearerHeader(auth) },
    });
    assert.equal(packagesResponse.statusCode, 200);
    const packages = packagesResponse.json() as Array<{ id: string; version: string }>;
    assert.equal(packages.length, 1);
    assert.equal(packages[0]?.id, fixture.packageId);
    assert.equal(packages[0]?.version, fixture.packageVersion);

    const packageResponse = await app.inject({
      method: "GET",
      url: `/registry/packages/${fixture.packageId}/${fixture.packageVersion}`,
      headers: { authorization: bearerHeader(auth) },
    });
    assert.equal(packageResponse.statusCode, 200);
    const packageBody = packageResponse.json() as { id: string; owner: string };
    assert.equal(packageBody.id, fixture.packageId);
    assert.equal(packageBody.owner, "control-plane-test");

    const snapshotResponse = await app.inject({
      method: "GET",
      url: `/registry/snapshots/${channel}`,
      headers: { authorization: bearerHeader(auth) },
    });
    assert.equal(snapshotResponse.statusCode, 200);
    const snapshotBody = snapshotResponse.json() as { snapshotId: string; channel: string };
    assert.equal(snapshotBody.snapshotId, ingestBody.snapshotId);
    assert.equal(snapshotBody.channel, channel);

    const manifest: CipherpolManifest = {
      schemaVersion: "cipherpol.mekari.com/v1",
      project: "control-plane-e2e-test",
      platforms: ["flutter"],
      channel: "canary",
      capabilityPacks: [capabilityPack.id],
      playbooks: [],
      policyProfile: "default",
      owners: ["test-owner"],
    };

    const canaryChannel = "canary";
    const canaryIngestResponse = await app.inject({
      method: "POST",
      url: "/registry/ingest",
      payload: {
        registryEnvelope: fixture.registryEnvelope,
        admissionEnvelopes: fixture.admissionEnvelopes,
        channel: canaryChannel,
      },
      headers: { authorization: bearerHeader(auth) },
    });
    assert.equal(canaryIngestResponse.statusCode, 201);
    t.after(() => cleanupFixtureRows(client, { channels: [canaryChannel] }));

    const resolveResponse = await app.inject({
      method: "POST",
      url: "/generations/resolve",
      payload: { manifest, client: { claudeCodeVersion: "1.5.0", capabilities: [] } },
      headers: { authorization: bearerHeader(auth) },
    });
    assert.equal(resolveResponse.statusCode, 200);
    const generation = resolveResponse.json() as { packages: Array<{ id: string }>; capabilityPacks: Array<{ id: string }> };
    assert.equal(generation.packages.length, 1);
    assert.equal(generation.packages[0]?.id, fixture.packageId);
    assert.equal(generation.capabilityPacks[0]?.id, capabilityPack.id);
  });

  test("rejects a tampered envelope with 422 and leaves prior data unchanged", async (t) => {
    const auth = await startTestGoogleAuth(t);
    const channel = uniqueChannel();
    const fixture = await buildSignedClosureFixture(t);
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));
    const app = buildServer(client, trustConfigFromFixture(fixture), auth.config);
    t.after(() => app.close());

    const firstIngest = await app.inject({
      method: "POST",
      url: "/registry/ingest",
      payload: {
        registryEnvelope: fixture.registryEnvelope,
        admissionEnvelopes: fixture.admissionEnvelopes,
        channel,
      },
      headers: { authorization: bearerHeader(auth) },
    });
    assert.equal(firstIngest.statusCode, 201);
    const firstSnapshotId = (firstIngest.json() as { snapshotId: string }).snapshotId;

    // Same key ID (still matches the server's pinned trust), but the signed
    // payload was mutated after signing: the signature no longer verifies.
    const tamperedEnvelope = {
      ...fixture.registryEnvelope,
      registryIndex: {
        ...fixture.registryEnvelope.registryIndex,
        packages: fixture.registryEnvelope.registryIndex.packages.map((record) => (
          record.id === fixture.packageId ? { ...record, owner: "attacker-owner" } : record
        )),
      },
    };

    const tamperedResponse = await app.inject({
      method: "POST",
      url: "/registry/ingest",
      payload: {
        registryEnvelope: tamperedEnvelope,
        admissionEnvelopes: fixture.admissionEnvelopes,
        channel,
      },
      headers: { authorization: bearerHeader(auth) },
    });
    assert.equal(tamperedResponse.statusCode, 422);
    const tamperedBody = tamperedResponse.json() as { code: string; message: string };
    assert.equal(tamperedBody.code, "INVALID_ENVELOPE");
    assert.ok(!("stack" in tamperedBody));

    // The prior snapshot must remain untouched and current; the persisted
    // package must still carry its original (never-tampered) content.
    const snapshotResponse = await app.inject({
      method: "GET",
      url: `/registry/snapshots/${channel}`,
      headers: { authorization: bearerHeader(auth) },
    });
    assert.equal(snapshotResponse.statusCode, 200);
    const snapshotBody = snapshotResponse.json() as { snapshotId: string };
    assert.equal(snapshotBody.snapshotId, firstSnapshotId);

    const { data: packageRow } = await client
      .from("packages")
      .select("owner")
      .eq("id", fixture.packageId)
      .eq("version", fixture.packageVersion)
      .single();
    assert.equal(packageRow?.owner, "control-plane-test");
  });

  test("returns a redacted 404 for an unknown channel", async (t) => {
    const auth = await startTestGoogleAuth(t);
    const first = await buildSignedClosureFixture(t);
    const app = buildServer(client, trustConfigFromFixture(first), auth.config);
    t.after(() => app.close());

    const response = await app.inject({
      method: "GET",
      url: `/registry/packages?channel=unknown-${uniqueSuffix()}`,
      headers: { authorization: bearerHeader(auth) },
    });
    assert.equal(response.statusCode, 404);
    const body = response.json() as { code: string; message: string };
    assert.equal(body.code, "UNKNOWN_CHANNEL");
  });

  test("a request body carrying trust fields is rejected with 422, not honored as an alternate root of trust", async (t) => {
    const auth = await startTestGoogleAuth(t);
    const channel = uniqueChannel();
    const fixture = await buildSignedClosureFixture(t);
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));
    // The server is pinned to trust `fixture`'s key. The request body below tries
    // to smuggle a *different* (attacker-controlled) key as the trust root.
    const attackerKeyPair = await buildSignedClosureFixture(t);
    const app = buildServer(client, trustConfigFromFixture(fixture), auth.config);
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/registry/ingest",
      payload: {
        registryEnvelope: fixture.registryEnvelope,
        admissionEnvelopes: fixture.admissionEnvelopes,
        channel,
        trustedKeyId: attackerKeyPair.keyId,
        trustedKeyPurpose: attackerKeyPair.keyPurpose,
        trustedPublicKeyPem: attackerKeyPair.publicKeyPem,
        allowFixtureKeys: true,
      },
      headers: { authorization: bearerHeader(auth) },
    });
    assert.equal(response.statusCode, 422);
    const body = response.json() as { code: string };
    assert.equal(body.code, "INVALID_ENVELOPE");

    const { data: packageRows } = await client.from("packages").select("id").eq("id", fixture.packageId);
    assert.deepEqual(packageRows, []);
  });

  test("rejects an envelope whose keyId does not match the server's pinned trusted key over HTTP", async (t) => {
    const auth = await startTestGoogleAuth(t);
    const channel = uniqueChannel();
    const fixture = await buildSignedClosureFixture(t);
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));
    const app = buildServer(client, trustConfigFromFixture(fixture), auth.config);
    t.after(() => app.close());

    const envelopeWithForeignKeyId = { ...fixture.registryEnvelope, keyId: "some-other-key-id" };

    const response = await app.inject({
      method: "POST",
      url: "/registry/ingest",
      payload: {
        registryEnvelope: envelopeWithForeignKeyId,
        admissionEnvelopes: fixture.admissionEnvelopes,
        channel,
      },
      headers: { authorization: bearerHeader(auth) },
    });
    assert.equal(response.statusCode, 422);
    const body = response.json() as { code: string; message: string };
    assert.equal(body.code, "INVALID_ENVELOPE");
    assert.match(body.message, /key ID/);

    const { data: packageRows } = await client.from("packages").select("id").eq("id", fixture.packageId);
    assert.deepEqual(packageRows, []);
  });
}
