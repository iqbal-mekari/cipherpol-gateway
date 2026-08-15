import assert from "node:assert/strict";
import test from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ControlPlaneError, ingestClosure } from "../src/index.js";
import { buildSignedClosureFixture, cleanupFixtureRows, trustConfigFromFixture, uniqueSuffix } from "./helpers/signed-closure.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  test.skip("ingest.test.ts requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (skipping — no live Supabase instance configured)", () => {});
} else {
  const client: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  function uniqueChannel(): string {
    return `ingest-test-${uniqueSuffix()}`;
  }

  test("ingests a small generated closure and persists its packages and snapshot", async (t) => {
    const channel = uniqueChannel();
    const fixture = await buildSignedClosureFixture(t);
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    const result = await ingestClosure(client, trustConfigFromFixture(fixture), {
      registryEnvelope: fixture.registryEnvelope,
      admissionEnvelopes: fixture.admissionEnvelopes,
      channel,
    });
    assert.ok(result.snapshotId.length > 0);

    const { data: packageRow, error: packageError } = await client
      .from("packages")
      .select("id, version, owner")
      .eq("id", fixture.packageId)
      .eq("version", fixture.packageVersion)
      .single();
    assert.equal(packageError, null);
    assert.equal(packageRow?.owner, "control-plane-test");

    const { data: snapshotRow, error: snapshotError } = await client
      .from("registry_snapshots")
      .select("id, channel, superseded_at")
      .eq("id", result.snapshotId)
      .single();
    assert.equal(snapshotError, null);
    assert.equal(snapshotRow?.channel, channel);
    assert.equal(snapshotRow?.superseded_at, null);
  });

  test("rejects an envelope whose keyId does not match the server's trusted key ID, before any verification", async (t) => {
    const channel = uniqueChannel();
    const fixture = await buildSignedClosureFixture(t);
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    const mismatchedTrust = { ...trustConfigFromFixture(fixture), trustedKeyId: "some-other-key-id" };

    await assert.rejects(
      () => ingestClosure(client, mismatchedTrust, {
        registryEnvelope: fixture.registryEnvelope,
        admissionEnvelopes: fixture.admissionEnvelopes,
        channel,
      }),
      (error: unknown) => (
        error instanceof ControlPlaneError
        && error.code === "INVALID_ENVELOPE"
        && /key ID/.test(error.message)
      ),
    );

    const { data: packageRows } = await client.from("packages").select("id").eq("id", fixture.packageId);
    assert.deepEqual(packageRows, []);
    const { data: snapshotRows } = await client.from("registry_snapshots").select("id").eq("channel", channel);
    assert.deepEqual(snapshotRows, []);
  });

  test("rejects a tampered aggregate registry signature and writes zero rows", async (t) => {
    const channel = uniqueChannel();
    const fixture = await buildSignedClosureFixture(t);
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    const tamperedEnvelope = {
      ...fixture.registryEnvelope,
      registryIndex: {
        ...fixture.registryEnvelope.registryIndex,
        packages: fixture.registryEnvelope.registryIndex.packages.map((record) => (
          record.id === fixture.packageId ? { ...record, owner: "attacker-owner" } : record
        )),
      },
    };

    await assert.rejects(
      () => ingestClosure(client, trustConfigFromFixture(fixture), {
        registryEnvelope: tamperedEnvelope,
        admissionEnvelopes: fixture.admissionEnvelopes,
        channel,
      }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "INVALID_ENVELOPE",
    );

    const { data: packageRows } = await client.from("packages").select("id").eq("id", fixture.packageId);
    assert.deepEqual(packageRows, []);
    const { data: snapshotRows } = await client.from("registry_snapshots").select("id").eq("channel", channel);
    assert.deepEqual(snapshotRows, []);
  });

  test("rejects a tampered per-package admission envelope and writes zero rows", async (t) => {
    const channel = uniqueChannel();
    const fixture = await buildSignedClosureFixture(t);
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    const tamperedAdmission = fixture.admissionEnvelopes[fixture.admissionPath];
    assert.ok(tamperedAdmission);
    const tamperedAdmissionEnvelopes = {
      ...fixture.admissionEnvelopes,
      [fixture.admissionPath]: {
        ...tamperedAdmission,
        packageRecord: { ...tamperedAdmission.packageRecord, owner: "attacker-owner" },
      },
    };

    await assert.rejects(
      () => ingestClosure(client, trustConfigFromFixture(fixture), {
        registryEnvelope: fixture.registryEnvelope,
        admissionEnvelopes: tamperedAdmissionEnvelopes,
        channel,
      }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "INVALID_ENVELOPE",
    );

    const { data: packageRows } = await client.from("packages").select("id").eq("id", fixture.packageId);
    assert.deepEqual(packageRows, []);
    const { data: snapshotRows } = await client.from("registry_snapshots").select("id").eq("channel", channel);
    assert.deepEqual(snapshotRows, []);
  });

  test("re-ingesting an identical (id, version) package into a different channel is a no-op", async (t) => {
    const channelA = uniqueChannel();
    const channelB = uniqueChannel();
    const fixture = await buildSignedClosureFixture(t);
    t.after(() => cleanupFixtureRows(client, { channels: [channelA, channelB], packageIds: [fixture.packageId] }));

    const trust = trustConfigFromFixture(fixture);
    const ingestInput = {
      registryEnvelope: fixture.registryEnvelope,
      admissionEnvelopes: fixture.admissionEnvelopes,
    };
    await ingestClosure(client, trust, { ...ingestInput, channel: channelA });
    await ingestClosure(client, trust, { ...ingestInput, channel: channelB });

    const { data: packageRows } = await client.from("packages").select("id, version").eq("id", fixture.packageId);
    assert.equal(packageRows?.length, 1);
  });

  test("re-ingesting a changed (id, version) package is rejected with INGEST_CONFLICT", async (t) => {
    const suffix = uniqueSuffix();
    const channelA = uniqueChannel();
    const channelB = uniqueChannel();
    const first = await buildSignedClosureFixture(t, { suffix, owner: "control-plane-test" });
    const second = await buildSignedClosureFixture(t, { suffix, owner: "different-owner" });
    t.after(() => cleanupFixtureRows(client, { channels: [channelA, channelB], packageIds: [first.packageId] }));

    await ingestClosure(client, trustConfigFromFixture(first), {
      registryEnvelope: first.registryEnvelope,
      admissionEnvelopes: first.admissionEnvelopes,
      channel: channelA,
    });

    await assert.rejects(
      () => ingestClosure(client, trustConfigFromFixture(second), {
        registryEnvelope: second.registryEnvelope,
        admissionEnvelopes: second.admissionEnvelopes,
        channel: channelB,
      }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "INGEST_CONFLICT",
    );

    // The conflicting ingestion must not have superseded or created anything for channelB.
    const { data: snapshotRows } = await client.from("registry_snapshots").select("id").eq("channel", channelB);
    assert.deepEqual(snapshotRows, []);
    const { data: packageRow } = await client
      .from("packages")
      .select("owner")
      .eq("id", first.packageId)
      .eq("version", first.packageVersion)
      .single();
    assert.equal(packageRow?.owner, "control-plane-test");
  });

  test("ingesting a new closure for the same channel supersedes the prior snapshot", async (t) => {
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

    const { data: firstRow } = await client
      .from("registry_snapshots")
      .select("superseded_at")
      .eq("id", firstResult.snapshotId)
      .single();
    assert.notEqual(firstRow?.superseded_at, null);

    const { data: secondRow } = await client
      .from("registry_snapshots")
      .select("superseded_at, channel")
      .eq("id", secondResult.snapshotId)
      .single();
    assert.equal(secondRow?.superseded_at, null);
    assert.equal(secondRow?.channel, channel);
  });

  test(
    "a mid-ingestion failure while swapping the current snapshot never leaves the channel without a current snapshot",
    async (t) => {
      const channel = uniqueChannel();
      const first = await buildSignedClosureFixture(t);
      const second = await buildSignedClosureFixture(t);
      t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [first.packageId, second.packageId] }));

      const firstResult = await ingestClosure(client, trustConfigFromFixture(first), {
        registryEnvelope: first.registryEnvelope,
        admissionEnvelopes: first.admissionEnvelopes,
        channel,
      });

      // Wrap the real client so the snapshot INSERT fails after the supersede UPDATE
      // has already succeeded, simulating a crash/network failure in that window.
      const failingClient = new Proxy(client, {
        get(target, prop, receiver) {
          if (prop !== "from") return Reflect.get(target, prop, receiver);
          return (table: string) => {
            const builder = (target.from as (table: string) => unknown)(table);
            if (table !== "registry_snapshots") return builder;
            return new Proxy(builder as object, {
              get(builderTarget, builderProp, builderReceiver) {
                if (builderProp !== "insert") return Reflect.get(builderTarget, builderProp, builderReceiver);
                return () => ({
                  select: () => ({
                    single: async () => ({ data: null, error: new Error("simulated snapshot insert failure") }),
                  }),
                });
              },
            });
          };
        },
      }) as SupabaseClient;

      await assert.rejects(
        () => ingestClosure(failingClient, trustConfigFromFixture(second), {
          registryEnvelope: second.registryEnvelope,
          admissionEnvelopes: second.admissionEnvelopes,
          channel,
        }),
        /simulated snapshot insert failure/,
      );

      // The first snapshot must have been restored to "current" (compensated
      // rollback), not left superseded with no replacement, and no half-written
      // second snapshot must exist.
      const { data: firstRow } = await client
        .from("registry_snapshots")
        .select("superseded_at")
        .eq("id", firstResult.snapshotId)
        .single();
      assert.equal(firstRow?.superseded_at, null);

      const { data: currentRows } = await client
        .from("registry_snapshots")
        .select("id")
        .eq("channel", channel)
        .is("superseded_at", null);
      assert.equal(currentRows?.length, 1);
      assert.equal(currentRows?.[0]?.id, firstResult.snapshotId);
    },
  );

  test(
    "when the compensating rollback update also fails, ingestClosure throws a distinct loud error naming both failures",
    async (t) => {
      const channel = uniqueChannel();
      const first = await buildSignedClosureFixture(t);
      const second = await buildSignedClosureFixture(t);
      t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [first.packageId, second.packageId] }));

      const firstResult = await ingestClosure(client, trustConfigFromFixture(first), {
        registryEnvelope: first.registryEnvelope,
        admissionEnvelopes: first.admissionEnvelopes,
        channel,
      });

      // Wrap the real client so both the snapshot INSERT and the compensating
      // rollback UPDATE (the one that restores `superseded_at = null`) fail,
      // simulating the DB becoming unreachable mid-compensation.
      const failingClient = new Proxy(client, {
        get(target, prop, receiver) {
          if (prop !== "from") return Reflect.get(target, prop, receiver);
          return (table: string) => {
            const builder = (target.from as (table: string) => unknown)(table);
            if (table !== "registry_snapshots") return builder;
            return new Proxy(builder as object, {
              get(builderTarget, builderProp, builderReceiver) {
                if (builderProp === "insert") {
                  return () => ({
                    select: () => ({
                      single: async () => ({ data: null, error: new Error("simulated snapshot insert failure") }),
                    }),
                  });
                }
                if (builderProp === "update") {
                  return (patch: Record<string, unknown>) => {
                    if (patch.superseded_at === null) {
                      return { eq: async () => ({ data: null, error: new Error("simulated rollback update failure") }) };
                    }
                    return (builderTarget as { update: (p: Record<string, unknown>) => unknown }).update(patch);
                  };
                }
                return Reflect.get(builderTarget, builderProp, builderReceiver);
              },
            });
          };
        },
      }) as SupabaseClient;

      await assert.rejects(
        () => ingestClosure(failingClient, trustConfigFromFixture(second), {
          registryEnvelope: second.registryEnvelope,
          admissionEnvelopes: second.admissionEnvelopes,
          channel,
        }),
        (error: unknown) => (
          error instanceof Error
          && !(error instanceof ControlPlaneError)
          && /simulated snapshot insert failure/.test(error.message)
          && /simulated rollback update failure/.test(error.message)
        ),
      );

      // The channel is left in the degraded (but loudly-reported) state: the
      // first snapshot's supersede was never rolled back because the rollback
      // itself failed, and no half-written second snapshot exists either.
      const { data: firstRow } = await client
        .from("registry_snapshots")
        .select("superseded_at")
        .eq("id", firstResult.snapshotId)
        .single();
      assert.notEqual(firstRow?.superseded_at, null);
    },
  );
}
