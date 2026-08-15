import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  buildServer,
  ControlPlaneError,
  ingestClosure,
  listActivations,
  recordActivation,
  registerProject,
  type ControlPlaneTrustConfig,
  type ProjectRecord,
} from "../src/index.js";
import {
  buildSignedClosureFixture,
  cleanupFixtureRows,
  trustConfigFromFixture,
  uniqueSuffix,
  type SignedClosureFixture,
} from "./helpers/signed-closure.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  test.skip("activations.test.ts requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (skipping — no live Supabase instance configured)", () => {});
} else {
  const client: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Activation routes never read the trust config — they are client-reported
  // telemetry. Any value works for `buildServer`.
  const trust: ControlPlaneTrustConfig = {
    trustedKeyId: "unused",
    trustedPublicKeyPem: "unused",
    trustedKeyPurpose: "fixture",
    allowFixtureKeys: true,
  };

  function localSuffix(): string {
    return randomBytes(4).toString("hex");
  }

  async function seedProject(t: TestContext, prefix: string): Promise<string> {
    const suffix = localSuffix();
    const id = `${prefix}-${suffix}`;
    const project: Omit<ProjectRecord, "registeredAt"> = {
      id,
      slug: `slug-${suffix}`,
      name: `Activation Test ${suffix}`,
      defaultChannel: "stable",
      platforms: ["darwin-arm64", "linux-x64"],
      owners: ["control-plane-test"],
    };
    await registerProject(client, project);
    t.after(() => client.from("projects").delete().eq("id", id));
    return id;
  }

  interface SeededSnapshot {
    readonly snapshotId: string;
    readonly channel: string;
    readonly fixture: SignedClosureFixture;
  }

  async function seedSnapshot(t: TestContext, prefix: string): Promise<SeededSnapshot> {
    const suffix = localSuffix();
    const channel = `${prefix}-${suffix}`;
    const fixture = await buildSignedClosureFixture(t, { suffix });
    const result = await ingestClosure(client, trustConfigFromFixture(fixture), {
      registryEnvelope: fixture.registryEnvelope,
      admissionEnvelopes: fixture.admissionEnvelopes,
      channel,
    });
    // Activation rows reference the snapshot, so they must be removed before the
    // snapshot (and its packages) — all within this single hook, in that order.
    t.after(async () => {
      await client.from("activation_records").delete().eq("channel", channel);
      await cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] });
    });
    return { snapshotId: result.snapshotId, channel, fixture };
  }

  test("recordActivation inserts and round-trips through listActivations", async (t) => {
    const projectId = await seedProject(t, "activations-roundtrip");
    const { snapshotId, channel } = await seedSnapshot(t, "activations-roundtrip");

    const { id } = await recordActivation(client, {
      projectId,
      channel,
      snapshotId,
      generationDigest: "sha256:roundtrip-digest",
      claudeCodeVersion: "1.2.3",
      capabilities: ["code-review", "web-search"],
    });
    assert.ok(id.length > 0);

    const rows = await listActivations(client, { channel });
    const mine = rows.filter((row) => row.id === id);
    assert.equal(mine.length, 1);
    const record = mine[0];
    assert.ok(record);
    assert.equal(record.projectId, projectId);
    assert.equal(record.channel, channel);
    assert.equal(record.snapshotId, snapshotId);
    assert.equal(record.generationDigest, "sha256:roundtrip-digest");
    assert.equal(record.claudeCodeVersion, "1.2.3");
    assert.deepEqual(record.capabilities, ["code-review", "web-search"]);
    assert.ok(record.activatedAt.length > 0);
  });

  test("recordActivation rejects an unknown snapshotId with a clean 404, not a 500", async (t) => {
    const { channel } = await seedSnapshot(t, "activations-unknown-snapshot");

    await assert.rejects(
      () =>
        recordActivation(client, {
          channel,
          snapshotId: randomUUID(),
          generationDigest: "sha256:whatever",
          claudeCodeVersion: "1.2.3",
        }),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "UNKNOWN_SNAPSHOT" && error.httpStatus === 404,
    );
  });

  test("recordActivation rejects an unknown projectId with a clean 404, not a 500", async (t) => {
    const { snapshotId, channel } = await seedSnapshot(t, "activations-unknown-project");

    await assert.rejects(
      () =>
        recordActivation(client, {
          projectId: `activations-nonexistent-${localSuffix()}`,
          channel,
          snapshotId,
          generationDigest: "sha256:whatever",
          claudeCodeVersion: "1.2.3",
        }),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "UNKNOWN_PROJECT" && error.httpStatus === 404,
    );
  });

  test("listActivations respects channel and projectId filters and returns newest-first", async (t) => {
    const projectA = await seedProject(t, "activations-filter-a");
    const projectB = await seedProject(t, "activations-filter-b");
    const snapA = await seedSnapshot(t, "activations-filter-a");
    const snapB = await seedSnapshot(t, "activations-filter-b");

    const first = await recordActivation(client, {
      projectId: projectA,
      channel: snapA.channel,
      snapshotId: snapA.snapshotId,
      generationDigest: "sha256:first",
      claudeCodeVersion: "1.0.0",
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await recordActivation(client, {
      projectId: projectB,
      channel: snapB.channel,
      snapshotId: snapB.snapshotId,
      generationDigest: "sha256:second",
      claudeCodeVersion: "1.0.0",
    });

    // Unfiltered: newest first.
    const all = await listActivations(client, {});
    const ids = all.map((row) => row.id);
    assert.ok(ids.indexOf(second.id) < ids.indexOf(first.id), "newest record should come first");

    // Channel filter isolates to the matching channel only.
    const byChannel = await listActivations(client, { channel: snapA.channel });
    assert.ok(byChannel.length >= 1);
    assert.ok(byChannel.every((row) => row.channel === snapA.channel));
    assert.ok(byChannel.some((row) => row.id === first.id));
    assert.ok(!byChannel.some((row) => row.id === second.id));

    // ProjectId filter isolates to the matching project only.
    const byProject = await listActivations(client, { projectId: projectB });
    assert.ok(byProject.length >= 1);
    assert.ok(byProject.every((row) => row.projectId === projectB));
    assert.ok(byProject.some((row) => row.id === second.id));
    assert.ok(!byProject.some((row) => row.id === first.id));
  });

  test("listActivations clamps an oversized limit instead of rejecting it", async (t) => {
    const { snapshotId, channel } = await seedSnapshot(t, "activations-limit");

    await recordActivation(client, {
      channel,
      snapshotId,
      generationDigest: "sha256:limit-1",
      claudeCodeVersion: "1.0.0",
    });
    await recordActivation(client, {
      channel,
      snapshotId,
      generationDigest: "sha256:limit-2",
      claudeCodeVersion: "1.0.0",
    });
    await recordActivation(client, {
      channel,
      snapshotId,
      generationDigest: "sha256:limit-3",
      claudeCodeVersion: "1.0.0",
    });

    // A limit above the 500 cap is honored (clamped), never an error.
    const oversized = await listActivations(client, { channel, limit: 9999 });
    assert.equal(oversized.length, 3);

    // A smaller limit is honored as a real bound.
    const bounded = await listActivations(client, { channel, limit: 2 });
    assert.equal(bounded.length, 2);
  });

  test("POST /activations returns 201 with the inserted id over HTTP", async (t) => {
    const projectId = await seedProject(t, "activations-http-post");
    const { snapshotId, channel } = await seedSnapshot(t, "activations-http-post");
    const app = buildServer(client, trust);
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/activations",
      payload: {
        projectId,
        channel,
        snapshotId,
        generationDigest: "sha256:http-post",
        claudeCodeVersion: "2.0.0",
        capabilities: ["code-review"],
      },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json() as { id: string };
    assert.ok(body.id.length > 0);
  });

  test("POST /activations returns a clean 404 (not 500) for an unknown snapshotId over HTTP", async (t) => {
    const { channel } = await seedSnapshot(t, "activations-http-unknown");
    const app = buildServer(client, trust);
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/activations",
      payload: {
        channel,
        snapshotId: randomUUID(),
        generationDigest: "sha256:http-unknown",
        claudeCodeVersion: "2.0.0",
      },
    });
    assert.equal(response.statusCode, 404);
    const body = response.json() as { code: string };
    assert.equal(body.code, "UNKNOWN_SNAPSHOT");
  });

  test("GET /activations returns the list over HTTP and honors filters", async (t) => {
    const projectId = await seedProject(t, "activations-http-get");
    const { snapshotId, channel } = await seedSnapshot(t, "activations-http-get");
    const app = buildServer(client, trust);
    t.after(() => app.close());

    const insertResponse = await app.inject({
      method: "POST",
      url: "/activations",
      payload: {
        projectId,
        channel,
        snapshotId,
        generationDigest: "sha256:http-get",
        claudeCodeVersion: "2.0.0",
      },
    });
    assert.equal(insertResponse.statusCode, 201);
    const inserted = insertResponse.json() as { id: string };

    const response = await app.inject({ method: "GET", url: `/activations?channel=${channel}` });
    assert.equal(response.statusCode, 200);
    const rows = response.json() as Array<{ id: string; channel: string; projectId: string }>;
    assert.ok(Array.isArray(rows));
    assert.ok(rows.some((row) => row.id === inserted.id));

    const filtered = await app.inject({ method: "GET", url: `/activations?projectId=${projectId}&limit=1` });
    assert.equal(filtered.statusCode, 200);
    const filteredRows = filtered.json() as Array<{ id: string }>;
    assert.equal(filteredRows.length, 1);
  });
}
