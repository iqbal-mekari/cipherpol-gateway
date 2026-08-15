import assert from "node:assert/strict";
import { sign } from "node:crypto";
import test, { type TestContext } from "node:test";
import { canonicalJson, type CapabilityPack, type CipherpolManifest, type Playbook } from "@cipherpol/contracts";
import type { Client } from "@cipherpol/resolver";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  buildServer,
  ControlPlaneError,
  ingestClosure,
  listPackages,
  resolveGenerationFromRegistry,
  revokeArtifact,
  type RevocationEnvelope,
  type RevocationRequest,
} from "../src/index.js";
import {
  buildSignedClosureFixture,
  cleanupFixtureRows,
  trustConfigFromFixture,
  uniqueSuffix,
  type SignedClosureFixture,
} from "./helpers/signed-closure.js";
import { bearerHeader, startTestGoogleAuth } from "./helpers/google-auth.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  test.skip("revocation.test.ts requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (skipping — no live Supabase instance configured)", () => {});
} else {
  const client: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const resolverClient: Client = { claudeCodeVersion: "1.5.0", capabilities: new Set() };

  function uniqueChannel(): string {
    return `revocation-test-${uniqueSuffix()}`;
  }

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

  function devPlaybook(suffix: string): Playbook {
    return {
      id: `cipherpol-test-${suffix}/playbook/security`,
      version: "1.0.0",
      owner: "control-plane-test",
      platforms: ["generic"],
      guidancePackages: [],
      hookPackages: [],
      validatorPackages: [],
      rules: [{
        id: `cipherpol-test-${suffix}/rule/one`,
        level: "recommend",
        rationale: "Prefer safe defaults",
        remediation: "Use the safe default",
      }],
      revoked: false,
    };
  }

  function manifestFor(channel: string, capabilityPackId: string): CipherpolManifest {
    return {
      schemaVersion: "cipherpol.mekari.com/v1",
      project: "control-plane-test-project",
      platforms: ["flutter"],
      channel: channel as CipherpolManifest["channel"],
      capabilityPacks: [capabilityPackId],
      playbooks: [],
      policyProfile: "default",
      owners: ["test-owner"],
    };
  }

  function signRevocationEnvelope(fixture: SignedClosureFixture, revocation: RevocationRequest): RevocationEnvelope {
    const signature = sign(
      null,
      Buffer.from(canonicalJson(revocation), "utf8"),
      fixture.privateKey,
    ).toString("base64");
    return {
      keyId: fixture.keyId,
      keyPurpose: fixture.keyPurpose,
      signature,
      revocation,
    };
  }

  async function ingestFixture(t: TestContext, options: {
    suffix: string;
    capabilityPacks?: readonly CapabilityPack[];
    playbooks?: readonly Playbook[];
  }): Promise<{ fixture: SignedClosureFixture; channel: string }> {
    const fixture = await buildSignedClosureFixture(t, options);
    const channel = uniqueChannel();
    await ingestClosure(client, trustConfigFromFixture(fixture), {
      registryEnvelope: fixture.registryEnvelope,
      admissionEnvelopes: fixture.admissionEnvelopes,
      channel,
    });
    return { fixture, channel };
  }

  function packageRevocation(fixture: SignedClosureFixture, action: "revoke" | "unrevoke"): RevocationRequest {
    return {
      kind: "package",
      id: fixture.packageId,
      version: fixture.packageVersion,
      action,
      requestedAt: new Date().toISOString(),
    };
  }

  async function revokedFlag(table: "packages" | "capability_packs" | "playbooks", id: string, version: string): Promise<boolean> {
    const { data, error } = await client
      .from(table)
      .select("revoked")
      .eq("id", id)
      .eq("version", version)
      .single();
    assert.equal(error, null);
    return data?.revoked as boolean;
  }

  test("a valid revocation flips packages.revoked and hides the package from list and resolve", async (t) => {
    const suffix = uniqueSuffix();
    const capabilityPack = devCapabilityPack(suffix);
    const { fixture, channel } = await ingestFixture(t, { suffix, capabilityPacks: [capabilityPack] });
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId, capabilityPack.id] }));

    const result = await revokeArtifact(client, trustConfigFromFixture(fixture), signRevocationEnvelope(fixture, packageRevocation(fixture, "revoke")));
    assert.deepEqual(result, { id: fixture.packageId, version: fixture.packageVersion, revoked: true });

    assert.equal(await revokedFlag("packages", fixture.packageId, fixture.packageVersion), true);

    const packages = await listPackages(client, channel);
    assert.ok(packages !== undefined);
    assert.equal(packages!.some((pkg) => pkg.id === fixture.packageId), false, "revoked package must be excluded from listPackages");

    const manifest = manifestFor(channel, capabilityPack.id);
    await assert.rejects(
      () => resolveGenerationFromRegistry(client, manifest, resolverClient),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "RESOLUTION_FAILED" && error.httpStatus === 422,
      "revoking the only eligible package must make the generation unresolvable",
    );
  });

  test("a valid unrevocation restores the package", async (t) => {
    const suffix = uniqueSuffix();
    const capabilityPack = devCapabilityPack(suffix);
    const { fixture, channel } = await ingestFixture(t, { suffix, capabilityPacks: [capabilityPack] });
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId, capabilityPack.id] }));

    const trust = trustConfigFromFixture(fixture);
    await revokeArtifact(client, trust, signRevocationEnvelope(fixture, packageRevocation(fixture, "revoke")));
    assert.equal(await revokedFlag("packages", fixture.packageId, fixture.packageVersion), true);

    const result = await revokeArtifact(client, trust, signRevocationEnvelope(fixture, packageRevocation(fixture, "unrevoke")));
    assert.deepEqual(result, { id: fixture.packageId, version: fixture.packageVersion, revoked: false });

    assert.equal(await revokedFlag("packages", fixture.packageId, fixture.packageVersion), false);
    const packages = await listPackages(client, channel);
    assert.ok(packages !== undefined);
    assert.equal(packages!.some((pkg) => pkg.id === fixture.packageId), true, "unrevoked package must reappear in listPackages");
  });

  test("rejects a revocation with the wrong keyId without mutating revoked", async (t) => {
    const suffix = uniqueSuffix();
    const { fixture, channel } = await ingestFixture(t, { suffix });
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    const envelope = signRevocationEnvelope(fixture, packageRevocation(fixture, "revoke"));
    const tampered: RevocationEnvelope = { ...envelope, keyId: "wrong-key-id" };

    await assert.rejects(
      () => revokeArtifact(client, trustConfigFromFixture(fixture), tampered),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "INVALID_ENVELOPE" && error.httpStatus === 422,
    );
    assert.equal(await revokedFlag("packages", fixture.packageId, fixture.packageVersion), false);
  });

  test("rejects a revocation with the wrong keyPurpose without mutating revoked", async (t) => {
    const suffix = uniqueSuffix();
    const { fixture, channel } = await ingestFixture(t, { suffix });
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    const envelope = signRevocationEnvelope(fixture, packageRevocation(fixture, "revoke"));
    const tampered: RevocationEnvelope = { ...envelope, keyPurpose: "production" };

    await assert.rejects(
      () => revokeArtifact(client, trustConfigFromFixture(fixture), tampered),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "INVALID_ENVELOPE" && error.httpStatus === 422,
    );
    assert.equal(await revokedFlag("packages", fixture.packageId, fixture.packageVersion), false);
  });

  test("rejects a tampered signature without mutating revoked", async (t) => {
    const suffix = uniqueSuffix();
    const { fixture, channel } = await ingestFixture(t, { suffix });
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    const envelope = signRevocationEnvelope(fixture, packageRevocation(fixture, "revoke"));
    const corrupted = (envelope.signature.charAt(0) === "A" ? "B" : "A") + envelope.signature.slice(1);
    const tampered: RevocationEnvelope = { ...envelope, signature: corrupted };

    await assert.rejects(
      () => revokeArtifact(client, trustConfigFromFixture(fixture), tampered),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "INVALID_ENVELOPE" && error.httpStatus === 422,
    );
    assert.equal(await revokedFlag("packages", fixture.packageId, fixture.packageVersion), false);
  });

  test("rejects a signed revocation whose kind/id/version/action was swapped after signing", async (t) => {
    const suffix = uniqueSuffix();
    const { fixture, channel } = await ingestFixture(t, { suffix });
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    // Sign a genuine "unrevoke" for this package, then splice in a different
    // target's identity/action while keeping the original signature — the
    // signature covers the whole RevocationRequest, so this must fail closed
    // rather than being honored against the substituted fields.
    const envelope = signRevocationEnvelope(fixture, packageRevocation(fixture, "unrevoke"));
    const substituted: RevocationEnvelope = {
      ...envelope,
      revocation: { ...envelope.revocation, action: "revoke" },
    };
    await assert.rejects(
      () => revokeArtifact(client, trustConfigFromFixture(fixture), substituted),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "INVALID_ENVELOPE" && error.httpStatus === 422,
      "swapping action after signing must invalidate the signature",
    );

    const otherId = `cipherpol-test-${suffix}/adapter/does-not-exist`;
    const substitutedTarget: RevocationEnvelope = {
      ...envelope,
      revocation: { ...envelope.revocation, id: otherId },
    };
    await assert.rejects(
      () => revokeArtifact(client, trustConfigFromFixture(fixture), substitutedTarget),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "INVALID_ENVELOPE" && error.httpStatus === 422,
      "swapping id after signing must invalidate the signature",
    );

    assert.equal(await revokedFlag("packages", fixture.packageId, fixture.packageVersion), false);
  });

  test("re-ingesting the same signed closure after one of its packages was revoked is still a no-op, not INGEST_CONFLICT", async (t) => {
    const suffix = uniqueSuffix();
    const { fixture, channel } = await ingestFixture(t, { suffix });
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    await revokeArtifact(client, trustConfigFromFixture(fixture), signRevocationEnvelope(fixture, packageRevocation(fixture, "revoke")));
    assert.equal(await revokedFlag("packages", fixture.packageId, fixture.packageVersion), true);

    // Re-ingesting the exact same signed envelope must remain a no-op (Slice 1/2's
    // idempotent-re-ingest guarantee) even though the package it contains has since
    // been revoked out-of-band — revocation must never surface as a spurious
    // INGEST_CONFLICT on the signed-content identity check.
    await ingestClosure(client, trustConfigFromFixture(fixture), {
      registryEnvelope: fixture.registryEnvelope,
      admissionEnvelopes: fixture.admissionEnvelopes,
      channel,
    });
    assert.equal(await revokedFlag("packages", fixture.packageId, fixture.packageVersion), true, "re-ingest must not resurrect a revoked package");
  });

  test("rejects a stale requestedAt without mutating revoked", async (t) => {
    const suffix = uniqueSuffix();
    const { fixture, channel } = await ingestFixture(t, { suffix });
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    const revocation: RevocationRequest = {
      ...packageRevocation(fixture, "revoke"),
      requestedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    };

    await assert.rejects(
      () => revokeArtifact(client, trustConfigFromFixture(fixture), signRevocationEnvelope(fixture, revocation)),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "INVALID_ENVELOPE" && error.httpStatus === 422,
    );
    assert.equal(await revokedFlag("packages", fixture.packageId, fixture.packageVersion), false);
  });

  test("rejects a future-dated requestedAt without mutating revoked", async (t) => {
    const suffix = uniqueSuffix();
    const { fixture, channel } = await ingestFixture(t, { suffix });
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    const revocation: RevocationRequest = {
      ...packageRevocation(fixture, "revoke"),
      requestedAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };

    await assert.rejects(
      () => revokeArtifact(client, trustConfigFromFixture(fixture), signRevocationEnvelope(fixture, revocation)),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "INVALID_ENVELOPE" && error.httpStatus === 422,
    );
    assert.equal(await revokedFlag("packages", fixture.packageId, fixture.packageVersion), false);
  });

  test("revoking an unknown (kind, id, version) returns undefined", async (t) => {
    const suffix = uniqueSuffix();
    const { fixture, channel } = await ingestFixture(t, { suffix });
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    const revocation: RevocationRequest = {
      kind: "package",
      id: `cipherpol-test-${suffix}/adapter/does-not-exist`,
      version: "1.0.0",
      action: "revoke",
      requestedAt: new Date().toISOString(),
    };

    const result = await revokeArtifact(client, trustConfigFromFixture(fixture), signRevocationEnvelope(fixture, revocation));
    assert.equal(result, undefined);
  });

  test("POST /revocations returns 200 on a valid revocation and 404 on an unknown artifact", async (t) => {
    const suffix = uniqueSuffix();
    const { fixture, channel } = await ingestFixture(t, { suffix });
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    const auth = await startTestGoogleAuth(t);
    const app = buildServer(client, trustConfigFromFixture(fixture), auth.config);
    t.after(() => app.close());

    const validResponse = await app.inject({
      method: "POST",
      url: "/revocations",
      headers: { authorization: bearerHeader(auth) },
      payload: signRevocationEnvelope(fixture, packageRevocation(fixture, "revoke")),
    });
    assert.equal(validResponse.statusCode, 200);
    assert.deepEqual(validResponse.json(), { id: fixture.packageId, version: fixture.packageVersion, revoked: true });

    const unknownEnvelope = signRevocationEnvelope(fixture, {
      kind: "package",
      id: `cipherpol-test-${suffix}/adapter/does-not-exist`,
      version: "1.0.0",
      action: "revoke",
      requestedAt: new Date().toISOString(),
    });
    const unknownResponse = await app.inject({ method: "POST", url: "/revocations", headers: { authorization: bearerHeader(auth) }, payload: unknownEnvelope });
    assert.equal(unknownResponse.statusCode, 404);
    assert.equal((unknownResponse.json() as { code: string }).code, "NOT_FOUND");
  });

  test("POST /revocations rejects a malformed envelope with 422", async (t) => {
    const suffix = uniqueSuffix();
    const { fixture, channel } = await ingestFixture(t, { suffix });
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    const auth = await startTestGoogleAuth(t);
    const app = buildServer(client, trustConfigFromFixture(fixture), auth.config);
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/revocations",
      headers: { authorization: bearerHeader(auth) },
      payload: { keyId: fixture.keyId, keyPurpose: fixture.keyPurpose, signature: "AAAA", revocation: { kind: "package", id: fixture.packageId } },
    });
    assert.equal(response.statusCode, 422);
    assert.equal((response.json() as { code: string }).code, "INVALID_ENVELOPE");
  });

  test("revokes a capability pack", async (t) => {
    const suffix = uniqueSuffix();
    const capabilityPack = devCapabilityPack(suffix);
    const { fixture, channel } = await ingestFixture(t, { suffix, capabilityPacks: [capabilityPack] });
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId, capabilityPack.id] }));

    const revocation: RevocationRequest = {
      kind: "capabilityPack",
      id: capabilityPack.id,
      version: capabilityPack.version,
      action: "revoke",
      requestedAt: new Date().toISOString(),
    };

    const result = await revokeArtifact(client, trustConfigFromFixture(fixture), signRevocationEnvelope(fixture, revocation));
    assert.deepEqual(result, { id: capabilityPack.id, version: capabilityPack.version, revoked: true });
    assert.equal(await revokedFlag("capability_packs", capabilityPack.id, capabilityPack.version), true);
  });

  test("revokes a playbook", async (t) => {
    const suffix = uniqueSuffix();
    const playbook = devPlaybook(suffix);
    const { fixture, channel } = await ingestFixture(t, { suffix, playbooks: [playbook] });
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId, playbook.id] }));

    const revocation: RevocationRequest = {
      kind: "playbook",
      id: playbook.id,
      version: playbook.version,
      action: "revoke",
      requestedAt: new Date().toISOString(),
    };

    const result = await revokeArtifact(client, trustConfigFromFixture(fixture), signRevocationEnvelope(fixture, revocation));
    assert.deepEqual(result, { id: playbook.id, version: playbook.version, revoked: true });
    assert.equal(await revokedFlag("playbooks", playbook.id, playbook.version), true);
  });
}
