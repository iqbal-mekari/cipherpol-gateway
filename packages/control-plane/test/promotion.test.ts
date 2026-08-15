import assert from "node:assert/strict";
import { sign } from "node:crypto";
import test from "node:test";
import { canonicalJson, type CapabilityPack, type CipherpolManifest } from "@cipherpol/contracts";
import type { Client } from "@cipherpol/resolver";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  buildServer,
  ControlPlaneError,
  getCurrentSnapshot,
  ingestClosure,
  promoteGeneration,
  resolveGenerationFromRegistry,
  revokeArtifact,
  type ControlPlaneTrustConfig,
} from "../src/index.js";
import { buildSignedClosureFixture, cleanupFixtureRows, trustConfigFromFixture, uniqueSuffix } from "./helpers/signed-closure.js";
import { startTestGoogleAuth, bearerHeader } from "./helpers/google-auth.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  test.skip("promotion.test.ts requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (skipping — no live Supabase instance configured)", () => {});
} else {
  const client: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const resolverClient: Client = { claudeCodeVersion: "1.5.0", capabilities: new Set() };

  // Never read by promoteGeneration for the "unknown channel" path, which throws
  // before any signature verification. Mirrors the dummy trust used by projects tests.
  const unusedTrust: ControlPlaneTrustConfig = {
    trustedKeyId: "unused",
    trustedPublicKeyPem: "unused",
    trustedKeyPurpose: "fixture",
    allowFixtureKeys: true,
  };

  function devCapabilityPack(suffix: string): CapabilityPack {
    return {
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
  }

  function manifestFor(channel: CipherpolManifest["channel"], capabilityPackId: string): CipherpolManifest {
    return {
      schemaVersion: "cipherpol.mekari.com/v1",
      project: "control-plane-test-project",
      platforms: ["flutter"],
      channel,
      capabilityPacks: [capabilityPackId],
      playbooks: [],
      policyProfile: "default",
      owners: ["test-owner"],
    };
  }

  test("promoting a canary snapshot to stable produces an identical stable snapshot and resolves the same generation", async (t) => {
    const suffix = uniqueSuffix();
    const capabilityPack = devCapabilityPack(suffix);
    const fixture = await buildSignedClosureFixture(t, { suffix, capabilityPacks: [capabilityPack] });
    const fromChannel = "canary";
    const toChannel = "stable";
    t.after(() => cleanupFixtureRows(client, {
      channels: [fromChannel, toChannel],
      packageIds: [fixture.packageId, capabilityPack.id],
    }));

    const trust = trustConfigFromFixture(fixture);
    await ingestClosure(client, trust, {
      registryEnvelope: fixture.registryEnvelope,
      admissionEnvelopes: fixture.admissionEnvelopes,
      channel: fromChannel,
    });

    const result = await promoteGeneration(client, trust, { fromChannel, toChannel });
    assert.ok(result.snapshotId.length > 0);

    const source = await getCurrentSnapshot(client, fromChannel);
    const target = await getCurrentSnapshot(client, toChannel);
    assert.ok(source !== undefined);
    assert.ok(target !== undefined);
    assert.equal(canonicalJson(target.registryEnvelope), canonicalJson(source.registryEnvelope));

    // The promoted channel resolves the exact same generation content as the source
    // channel. The channel label and the channel-derived generationId necessarily
    // differ (generationId hashes the channel); the resolved artifacts do not.
    const canaryGeneration = await resolveGenerationFromRegistry(
      client, manifestFor("canary", capabilityPack.id), resolverClient,
    );
    const stableGeneration = await resolveGenerationFromRegistry(
      client, manifestFor("stable", capabilityPack.id), resolverClient,
    );
    assert.equal(canaryGeneration.channel, "canary");
    assert.equal(stableGeneration.channel, "stable");
    assert.deepEqual(stableGeneration.packages, canaryGeneration.packages);
    assert.deepEqual(stableGeneration.capabilityPacks, canaryGeneration.capabilityPacks);
    assert.deepEqual(stableGeneration.playbooks, canaryGeneration.playbooks);
    assert.deepEqual(stableGeneration.toolBundles, canaryGeneration.toolBundles);
    assert.deepEqual(stableGeneration.requiredEvidence, canaryGeneration.requiredEvidence);
  });

  test("promoting from a channel with no current snapshot throws UNKNOWN_CHANNEL (404)", async () => {
    const suffix = uniqueSuffix();
    await assert.rejects(
      () => promoteGeneration(client, unusedTrust, {
        fromChannel: `promotion-test-missing-${suffix}`,
        toChannel: `promotion-test-${suffix}`,
      }),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "UNKNOWN_CHANNEL" && error.httpStatus === 404,
    );
  });

  test("re-promoting an already-promoted generation is a content-level no-op (no duplicate package rows; a fresh snapshot row)", async (t) => {
    const suffix = uniqueSuffix();
    const fixture = await buildSignedClosureFixture(t);
    const fromChannel = `promotion-src-${suffix}`;
    const toChannel = `promotion-dst-${suffix}`;
    t.after(() => cleanupFixtureRows(client, {
      channels: [fromChannel, toChannel],
      packageIds: [fixture.packageId],
    }));

    const trust = trustConfigFromFixture(fixture);
    await ingestClosure(client, trust, {
      registryEnvelope: fixture.registryEnvelope,
      admissionEnvelopes: fixture.admissionEnvelopes,
      channel: fromChannel,
    });

    const first = await promoteGeneration(client, trust, { fromChannel, toChannel });
    const second = await promoteGeneration(client, trust, { fromChannel, toChannel });

    // ingestClosure's idempotency is at the content level: identical (id, version)
    // package rows are a no-op, so re-promoting adds zero duplicate package rows…
    const { data: packageRows } = await client.from("packages").select("id, version").eq("id", fixture.packageId);
    assert.equal(packageRows?.length, 1);

    // …but it still supersedes the target channel's current snapshot and inserts a
    // fresh one, so the returned snapshotId differs and the channel has two rows
    // (one superseded, one current).
    const { data: snapshotRows } = await client
      .from("registry_snapshots")
      .select("id, superseded_at")
      .eq("channel", toChannel);
    assert.equal(snapshotRows?.length, 2);
    assert.notEqual(first.snapshotId, second.snapshotId);

    const current = await getCurrentSnapshot(client, toChannel);
    assert.ok(current !== undefined);
    assert.equal(current.snapshotId, second.snapshotId);

    const source = await getCurrentSnapshot(client, fromChannel);
    assert.ok(source !== undefined);
    assert.equal(canonicalJson(current.registryEnvelope), canonicalJson(source.registryEnvelope));
  });

  test("promoting a channel containing a since-revoked package is still a no-op, not a spurious INGEST_CONFLICT", async (t) => {
    const suffix = uniqueSuffix();
    const fixture = await buildSignedClosureFixture(t);
    const fromChannel = `promotion-revoked-src-${suffix}`;
    const toChannel = `promotion-revoked-dst-${suffix}`;
    t.after(() => cleanupFixtureRows(client, {
      channels: [fromChannel, toChannel],
      packageIds: [fixture.packageId],
    }));

    const trust = trustConfigFromFixture(fixture);
    await ingestClosure(client, trust, {
      registryEnvelope: fixture.registryEnvelope,
      admissionEnvelopes: fixture.admissionEnvelopes,
      channel: fromChannel,
    });

    const revocation = {
      kind: "package" as const,
      id: fixture.packageId,
      version: fixture.packageVersion,
      action: "revoke" as const,
      requestedAt: new Date().toISOString(),
    };
    await revokeArtifact(client, trust, {
      keyId: fixture.keyId,
      keyPurpose: fixture.keyPurpose,
      signature: sign(null, Buffer.from(canonicalJson(revocation), "utf8"), fixture.privateKey).toString("base64"),
      revocation,
    });

    // Promotion re-ingests the source channel's already-verified envelope
    // verbatim; this must succeed even though the package it contains was
    // revoked out-of-band after the original ingest.
    const result = await promoteGeneration(client, trust, { fromChannel, toChannel });
    assert.ok(result.snapshotId.length > 0);

    const { data: row } = await client
      .from("packages")
      .select("revoked")
      .eq("id", fixture.packageId)
      .eq("version", fixture.packageVersion)
      .single();
    assert.equal(row?.revoked, true, "promotion must not resurrect a revoked package");
  });

  test("POST /generations/promote promotes a snapshot over HTTP and returns 200 { snapshotId }", async (t) => {
    const auth = await startTestGoogleAuth(t);
    const suffix = uniqueSuffix();

    const fixture = await buildSignedClosureFixture(t);
    const fromChannel = `promotion-http-src-${suffix}`;
    const toChannel = `promotion-http-dst-${suffix}`;
    t.after(() => cleanupFixtureRows(client, {
      channels: [fromChannel, toChannel],
      packageIds: [fixture.packageId],
    }));

    const trust = trustConfigFromFixture(fixture);
    const app = buildServer(client, trust, auth.config);
    t.after(() => app.close());

    await ingestClosure(client, trust, {
      registryEnvelope: fixture.registryEnvelope,
      admissionEnvelopes: fixture.admissionEnvelopes,
      channel: fromChannel,
    });

    const response = await app.inject({
      method: "POST",
      url: "/generations/promote",
      payload: { fromChannel, toChannel },
      headers: { authorization: bearerHeader(auth) },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { snapshotId: string };
    assert.ok(body.snapshotId.length > 0);

    const target = await getCurrentSnapshot(client, toChannel);
    assert.ok(target !== undefined);
    assert.equal(target.snapshotId, body.snapshotId);
  });

  test("POST /generations/promote returns 404 UNKNOWN_CHANNEL for an unknown source channel over HTTP", async (t) => {
    const auth = await startTestGoogleAuth(t);
    const app = buildServer(client, unusedTrust, auth.config);
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/generations/promote",
      payload: {
        fromChannel: `promotion-http-missing-${uniqueSuffix()}`,
        toChannel: `promotion-http-dst-${uniqueSuffix()}`,
      },
      headers: { authorization: bearerHeader(auth) },
    });
    assert.equal(response.statusCode, 404);
    const body = response.json() as { code: string };
    assert.equal(body.code, "UNKNOWN_CHANNEL");
  });
}
