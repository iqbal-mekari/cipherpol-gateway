import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilityPack, CipherpolManifest } from "@cipherpol/contracts";
import { resolveGeneration, type Client } from "@cipherpol/resolver";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ControlPlaneError, ingestClosure, resolveGenerationFromRegistry } from "../src/index.js";
import { buildSignedClosureFixture, cleanupFixtureRows, trustConfigFromFixture, uniqueSuffix } from "./helpers/signed-closure.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  test.skip("generations.test.ts requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (skipping — no live Supabase instance configured)", () => {});
} else {
  const client: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const resolverClient: Client = { claudeCodeVersion: "1.5.0", capabilities: new Set() };

  test("resolves a generation against a persisted snapshot matching direct in-memory resolution", async (t) => {
    const suffix = uniqueSuffix();
    // `resolveGeneration`'s output is validated against `generationSchema`, whose
    // `channel` field is a fixed 3-value enum ("canary" | "stable" | "pinned") — unlike
    // the ingestion `channel` column, it cannot carry a random per-test-run suffix.
    // Package/capability-pack IDs stay suffix-unique; only this literal channel value
    // is shared, and the `t.after` cleanup below removes this test's snapshot row.
    const channel: CipherpolManifest["channel"] = "stable";
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

    const manifest: CipherpolManifest = {
      schemaVersion: "cipherpol.mekari.com/v1",
      project: "control-plane-test-project",
      platforms: ["flutter"],
      channel,
      capabilityPacks: [capabilityPack.id],
      playbooks: [],
      policyProfile: "default",
      owners: ["test-owner"],
    };

    await ingestClosure(client, trustConfigFromFixture(fixture), {
      registryEnvelope: fixture.registryEnvelope,
      admissionEnvelopes: fixture.admissionEnvelopes,
      channel,
    });

    const generation = await resolveGenerationFromRegistry(client, manifest, resolverClient);
    const expected = resolveGeneration(manifest, fixture.registryIndex, resolverClient);
    assert.deepEqual(generation, expected);
    assert.equal(generation.packages.length, 1);
    assert.equal(generation.packages[0]?.id, fixture.packageId);
    assert.equal(generation.capabilityPacks.length, 1);
    assert.equal(generation.capabilityPacks[0]?.id, capabilityPack.id);
  });

  test("maps an unresolvable manifest to RESOLUTION_FAILED", async (t) => {
    const suffix = uniqueSuffix();
    const channel = `generations-test-${suffix}` as CipherpolManifest["channel"];
    // A capability pack referencing a package version that does not exist in the
    // ingested registry index makes the generation unresolvable.
    const capabilityPack: CapabilityPack = {
      id: `cipherpol-test-${suffix}/pack/dev`,
      version: "1.0.0",
      intents: ["dev"],
      platforms: ["generic"],
      orchestrator: `cipherpol-test-${suffix}/adapter/cp1@^9.0.0`,
      packages: [`cipherpol-test-${suffix}/adapter/cp1@^9.0.0`],
      playbooks: [],
      requiredEvidence: [],
      revoked: false,
    };
    const fixture = await buildSignedClosureFixture(t, { suffix, capabilityPacks: [capabilityPack] });
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId, capabilityPack.id] }));

    const manifest: CipherpolManifest = {
      schemaVersion: "cipherpol.mekari.com/v1",
      project: "control-plane-test-project",
      platforms: ["flutter"],
      channel,
      capabilityPacks: [capabilityPack.id],
      playbooks: [],
      policyProfile: "default",
      owners: ["test-owner"],
    };

    await ingestClosure(client, trustConfigFromFixture(fixture), {
      registryEnvelope: fixture.registryEnvelope,
      admissionEnvelopes: fixture.admissionEnvelopes,
      channel,
    });

    await assert.rejects(
      () => resolveGenerationFromRegistry(client, manifest, resolverClient),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "RESOLUTION_FAILED" && error.httpStatus === 422,
    );
  });

  test("maps an unknown channel to UNKNOWN_CHANNEL", async () => {
    const manifest: CipherpolManifest = {
      schemaVersion: "cipherpol.mekari.com/v1",
      project: "control-plane-test-project",
      platforms: ["flutter"],
      channel: `generations-test-unknown-${uniqueSuffix()}` as CipherpolManifest["channel"],
      capabilityPacks: ["cipherpol-test-unknown/pack/dev"],
      playbooks: [],
      policyProfile: "default",
      owners: ["test-owner"],
    };

    await assert.rejects(
      () => resolveGenerationFromRegistry(client, manifest, resolverClient),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "UNKNOWN_CHANNEL" && error.httpStatus === 404,
    );
  });
}
