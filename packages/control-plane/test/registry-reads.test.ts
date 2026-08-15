import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getCurrentSnapshot, getPackage, ingestClosure, listPackages } from "../src/index.js";
import { buildSignedClosureFixture, cleanupFixtureRows, trustConfigFromFixture, uniqueSuffix } from "./helpers/signed-closure.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  test.skip("registry-reads.test.ts requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (skipping — no live Supabase instance configured)", () => {});
} else {
  const client: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  function uniqueChannel(): string {
    return `reads-test-${uniqueSuffix()}`;
  }

  async function ingestFixtureFor(t: TestContext, channel: string) {
    const fixture = await buildSignedClosureFixture(t);
    const result = await ingestClosure(client, trustConfigFromFixture(fixture), {
      registryEnvelope: fixture.registryEnvelope,
      admissionEnvelopes: fixture.admissionEnvelopes,
      channel,
    });
    return { fixture, snapshotId: result.snapshotId };
  }

  test("lists the packages in the current snapshot for a channel", async (t) => {
    const channel = uniqueChannel();
    const { fixture } = await ingestFixtureFor(t, channel);
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    const packages = await listPackages(client, channel);
    assert.ok(packages);
    assert.equal(packages.length, 1);
    assert.equal(packages[0]?.id, fixture.packageId);
    assert.equal(packages[0]?.version, fixture.packageVersion);
  });

  test("returns undefined listing packages for an unknown channel", async () => {
    const packages = await listPackages(client, `reads-test-unknown-${uniqueSuffix()}`);
    assert.equal(packages, undefined);
  });

  test("gets one package directly by id and version", async (t) => {
    const channel = uniqueChannel();
    const { fixture } = await ingestFixtureFor(t, channel);
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    const record = await getPackage(client, fixture.packageId, fixture.packageVersion);
    assert.ok(record);
    assert.equal(record.id, fixture.packageId);
    assert.equal(record.version, fixture.packageVersion);
    assert.equal(record.owner, "control-plane-test");
    assert.equal(record.kind, "adapter");
  });

  test("returns undefined getting an unknown package", async () => {
    const record = await getPackage(client, `cipherpol-test-${uniqueSuffix()}/adapter/cp1`, "1.0.0");
    assert.equal(record, undefined);
  });

  test("gets the current snapshot for a channel", async (t) => {
    const channel = uniqueChannel();
    const { fixture, snapshotId } = await ingestFixtureFor(t, channel);
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    const snapshot = await getCurrentSnapshot(client, channel);
    assert.ok(snapshot);
    assert.equal(snapshot.snapshotId, snapshotId);
    assert.equal(snapshot.channel, channel);
    assert.equal(snapshot.keyId, fixture.keyId);
    assert.equal(snapshot.keyPurpose, fixture.keyPurpose);
    assert.equal(snapshot.registryEnvelope.registryIndex.packages.length, 1);
  });

  test("returns undefined getting the current snapshot for an unknown channel", async () => {
    const snapshot = await getCurrentSnapshot(client, `reads-test-unknown-${uniqueSuffix()}`);
    assert.equal(snapshot, undefined);
  });
}
