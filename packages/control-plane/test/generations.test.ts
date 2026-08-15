import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilityPack, CipherpolManifest } from "@cipherpol/contracts";
import { resolveGeneration, type Client } from "@cipherpol/resolver";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assignPolicyProfile, buildServer, ControlPlaneError, ingestClosure, registerPolicyProfile, registerProject, resolveGenerationFromRegistry } from "../src/index.js";
import type { ProjectRecord } from "../src/index.js";
import { bearerHeader, startTestGoogleAuth } from "./helpers/google-auth.js";
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

  // --- Policy-enforcement test scaffolding (policy-profiles slice). Each helper
  // builds suffix-unique rows so concurrent runs never collide, and `t.after`
  // cleanup removes only that test's own project/profile/snapshot/package rows.

  function resolvableCapabilityPack(suffix: string): CapabilityPack {
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

  function resolvableManifest(
    suffix: string,
    channel: CipherpolManifest["channel"],
    capabilityPackId: string,
  ): CipherpolManifest {
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

  function policyProjectInput(suffix: string): Omit<ProjectRecord, "registeredAt"> {
    return {
      id: `generations-policy-project-${suffix}`,
      slug: `generations-policy-slug-${suffix}`,
      name: `Generations Policy Project ${suffix}`,
      defaultChannel: "stable",
      platforms: ["flutter"],
      owners: ["control-plane-test"],
    };
  }

  async function cleanupPolicyProjectRows(projectIds: readonly string[], profileIds: readonly string[]): Promise<void> {
    for (const id of projectIds) {
      await client.from("projects").delete().eq("id", id);
    }
    for (const id of profileIds) {
      await client.from("policy_profiles").delete().eq("id", id);
    }
  }

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

  test("a project with no policy profile resolves without any policy check", async (t) => {
    const suffix = uniqueSuffix();
    const channel: CipherpolManifest["channel"] = "stable";
    const capabilityPack = resolvableCapabilityPack(suffix);
    const fixture = await buildSignedClosureFixture(t, { suffix, capabilityPacks: [capabilityPack] });
    const project = policyProjectInput(suffix);
    t.after(() => cleanupPolicyProjectRows([project.id], []));
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId, capabilityPack.id] }));

    await ingestClosure(client, trustConfigFromFixture(fixture), {
      registryEnvelope: fixture.registryEnvelope,
      admissionEnvelopes: fixture.admissionEnvelopes,
      channel,
    });
    await registerProject(client, project);

    const manifest = resolvableManifest(suffix, channel, capabilityPack.id);
    const generation = await resolveGenerationFromRegistry(client, manifest, resolverClient, project.id);
    assert.equal(generation.capabilityPacks[0]?.id, capabilityPack.id);
  });

  test("a profile excluding the resolved capability pack fails with POLICY_VIOLATION even though the manifest resolves standalone", async (t) => {
    const suffix = uniqueSuffix();
    const channel: CipherpolManifest["channel"] = "stable";
    const capabilityPack = resolvableCapabilityPack(suffix);
    const fixture = await buildSignedClosureFixture(t, { suffix, capabilityPacks: [capabilityPack] });
    const project = policyProjectInput(suffix);
    const profileId = `generations-policy-profile-${suffix}`;
    t.after(() => cleanupPolicyProjectRows([project.id], [profileId]));
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId, capabilityPack.id] }));

    await ingestClosure(client, trustConfigFromFixture(fixture), {
      registryEnvelope: fixture.registryEnvelope,
      admissionEnvelopes: fixture.admissionEnvelopes,
      channel,
    });
    await registerProject(client, project);
    await registerPolicyProfile(client, {
      id: profileId,
      name: `Policy ${suffix}`,
      allowedCapabilityPacks: [`cipherpol-test-${suffix}/pack/other`],
    });
    await assignPolicyProfile(client, project.id, profileId);

    const manifest = resolvableManifest(suffix, channel, capabilityPack.id);

    // Without a projectId the manifest resolves fine on its own.
    const standalone = await resolveGenerationFromRegistry(client, manifest, resolverClient);
    assert.equal(standalone.capabilityPacks[0]?.id, capabilityPack.id);

    // With the projectId, the assigned profile rejects the resolved pack.
    await assert.rejects(
      () => resolveGenerationFromRegistry(client, manifest, resolverClient, project.id),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "POLICY_VIOLATION" && error.httpStatus === 422,
    );
  });

  test("a profile excluding the manifest's declared platform fails with POLICY_VIOLATION", async (t) => {
    const suffix = uniqueSuffix();
    const channel: CipherpolManifest["channel"] = "stable";
    const capabilityPack = resolvableCapabilityPack(suffix);
    const fixture = await buildSignedClosureFixture(t, { suffix, capabilityPacks: [capabilityPack] });
    const project = policyProjectInput(suffix);
    const profileId = `generations-policy-profile-${suffix}`;
    t.after(() => cleanupPolicyProjectRows([project.id], [profileId]));
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId, capabilityPack.id] }));

    await ingestClosure(client, trustConfigFromFixture(fixture), {
      registryEnvelope: fixture.registryEnvelope,
      admissionEnvelopes: fixture.admissionEnvelopes,
      channel,
    });
    await registerProject(client, project);
    await registerPolicyProfile(client, {
      id: profileId,
      name: `Policy ${suffix}`,
      allowedPlatforms: ["web-nextjs"],
    });
    await assignPolicyProfile(client, project.id, profileId);

    const manifest = resolvableManifest(suffix, channel, capabilityPack.id);
    await assert.rejects(
      () => resolveGenerationFromRegistry(client, manifest, resolverClient, project.id),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "POLICY_VIOLATION" && error.httpStatus === 422,
    );
  });

  test("a compliant project whose profile allows the pack and platform resolves successfully", async (t) => {
    const suffix = uniqueSuffix();
    const channel: CipherpolManifest["channel"] = "stable";
    const capabilityPack = resolvableCapabilityPack(suffix);
    const fixture = await buildSignedClosureFixture(t, { suffix, capabilityPacks: [capabilityPack] });
    const project = policyProjectInput(suffix);
    const profileId = `generations-policy-profile-${suffix}`;
    t.after(() => cleanupPolicyProjectRows([project.id], [profileId]));
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId, capabilityPack.id] }));

    await ingestClosure(client, trustConfigFromFixture(fixture), {
      registryEnvelope: fixture.registryEnvelope,
      admissionEnvelopes: fixture.admissionEnvelopes,
      channel,
    });
    await registerProject(client, project);
    await registerPolicyProfile(client, {
      id: profileId,
      name: `Policy ${suffix}`,
      allowedCapabilityPacks: [capabilityPack.id],
      allowedPlatforms: ["flutter"],
    });
    await assignPolicyProfile(client, project.id, profileId);

    const manifest = resolvableManifest(suffix, channel, capabilityPack.id);
    const generation = await resolveGenerationFromRegistry(client, manifest, resolverClient, project.id);
    assert.equal(generation.capabilityPacks[0]?.id, capabilityPack.id);
  });

  test("an unknown projectId fails with UNKNOWN_PROJECT 404", async (t) => {
    const suffix = uniqueSuffix();
    const channel: CipherpolManifest["channel"] = "stable";
    const capabilityPack = resolvableCapabilityPack(suffix);
    const fixture = await buildSignedClosureFixture(t, { suffix, capabilityPacks: [capabilityPack] });
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId, capabilityPack.id] }));

    await ingestClosure(client, trustConfigFromFixture(fixture), {
      registryEnvelope: fixture.registryEnvelope,
      admissionEnvelopes: fixture.admissionEnvelopes,
      channel,
    });

    const manifest = resolvableManifest(suffix, channel, capabilityPack.id);
    await assert.rejects(
      () => resolveGenerationFromRegistry(client, manifest, resolverClient, `generations-policy-unknown-${suffix}`),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "UNKNOWN_PROJECT" && error.httpStatus === 404,
    );
  });

  test("POST /generations/resolve enforces the project's policy profile over HTTP", async (t) => {
    const auth = await startTestGoogleAuth(t);
    const suffix = uniqueSuffix();
    const channel: CipherpolManifest["channel"] = "stable";
    const capabilityPack = resolvableCapabilityPack(suffix);
    const fixture = await buildSignedClosureFixture(t, { suffix, capabilityPacks: [capabilityPack] });
    const project = policyProjectInput(suffix);
    const profileId = `generations-policy-profile-${suffix}`;
    t.after(() => cleanupPolicyProjectRows([project.id], [profileId]));
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId, capabilityPack.id] }));

    await ingestClosure(client, trustConfigFromFixture(fixture), {
      registryEnvelope: fixture.registryEnvelope,
      admissionEnvelopes: fixture.admissionEnvelopes,
      channel,
    });
    await registerProject(client, project);
    await registerPolicyProfile(client, {
      id: profileId,
      name: `Policy ${suffix}`,
      allowedCapabilityPacks: [`cipherpol-test-${suffix}/pack/other`],
    });
    await assignPolicyProfile(client, project.id, profileId);

    const app = buildServer(client, trustConfigFromFixture(fixture), auth.config);
    t.after(() => app.close());

    const manifest = resolvableManifest(suffix, channel, capabilityPack.id);
    const response = await app.inject({
      method: "POST",
      url: "/generations/resolve",
      headers: { authorization: bearerHeader(auth) },
      payload: {
        manifest,
        client: { claudeCodeVersion: "1.5.0", capabilities: [] },
        projectId: project.id,
      },
    });
    assert.equal(response.statusCode, 422);
    const body = response.json() as { code: string };
    assert.equal(body.code, "POLICY_VIOLATION");
  });
}
