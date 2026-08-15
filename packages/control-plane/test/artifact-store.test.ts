import assert from "node:assert/strict";
import test from "node:test";
import { canonicalArtifactDigest } from "@cipherpol/contracts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  buildServer,
  ControlPlaneError,
  getPackageArtifacts,
  ingestClosure,
  storePackageArtifacts,
} from "../src/index.js";
import { bearerHeader, startTestGoogleAuth } from "./helpers/google-auth.js";
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
  test.skip("artifact-store.test.ts requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (skipping — no live Supabase instance configured)", () => {});
} else {
  const client: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  function uniqueChannel(): string {
    return `artifact-store-test-${uniqueSuffix()}`;
  }

  /**
   * Reconstructs the single artifact file a `buildSignedClosureFixture` fixture
   * was admitted from (a `manifest.json` whose content is deterministic in the
   * fixture's suffix) and its canonical digest. `buildSignedClosureFixture` signs
   * a real closure over that exact file, so the recomputed digest must equal the
   * package's signed digest.
   */
  function fixtureArtifact(fixture: SignedClosureFixture): {
    readonly source: string;
    readonly bytes: Uint8Array;
    readonly base64: string;
    readonly digest: string;
  } {
    const pkg = fixture.registryIndex.packages[0];
    if (pkg === undefined) throw new Error("expected fixture registry index to contain a package");
    const entry = pkg.files[0];
    if (entry === undefined) throw new Error("expected fixture package to declare a file");
    const bytes = Buffer.from(`# CP1 adapter manifest ${fixture.suffix}\n`, "utf8");
    return {
      source: entry.source,
      bytes,
      base64: bytes.toString("base64"),
      digest: canonicalArtifactDigest([{ path: entry.source, bytes }]),
    };
  }

  test("storePackageArtifacts + getPackageArtifacts round-trips content, mode, and digest", async (t) => {
    const channel = uniqueChannel();
    const fixture = await buildSignedClosureFixture(t);
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    await ingestClosure(client, trustConfigFromFixture(fixture), {
      registryEnvelope: fixture.registryEnvelope,
      admissionEnvelopes: fixture.admissionEnvelopes,
      channel,
    });

    // Binary content (NUL + 0xFF) exercises the bytea hex round-trip.
    const bytes = new Uint8Array([0x00, 0x01, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xff]);
    await storePackageArtifacts(client, {
      packageId: fixture.packageId,
      version: fixture.packageVersion,
      files: [{ path: "manifest.json", content: bytes, mode: 0o755 }],
    });

    const artifacts = await getPackageArtifacts(client, fixture.packageId, fixture.packageVersion);
    assert.ok(artifacts);
    assert.equal(artifacts.packageId, fixture.packageId);
    assert.equal(artifacts.version, fixture.packageVersion);
    assert.equal(artifacts.digest, fixture.registryIndex.packages[0]?.digest);
    assert.deepEqual(artifacts.files, [
      { path: "manifest.json", contentBase64: Buffer.from(bytes).toString("base64"), mode: 0o755 },
    ]);
  });

  test("ingest with valid artifacts stores them and reads back the correct digest", async (t) => {
    const channel = uniqueChannel();
    const fixture = await buildSignedClosureFixture(t);
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    const artifact = fixtureArtifact(fixture);
    assert.equal(artifact.digest, fixture.registryIndex.packages[0]?.digest);

    await ingestClosure(client, trustConfigFromFixture(fixture), {
      registryEnvelope: fixture.registryEnvelope,
      admissionEnvelopes: fixture.admissionEnvelopes,
      channel,
      artifacts: {
        [`${fixture.packageId}@${fixture.packageVersion}`]: { [artifact.source]: artifact.base64 },
      },
    });

    const artifacts = await getPackageArtifacts(client, fixture.packageId, fixture.packageVersion);
    assert.ok(artifacts);
    assert.equal(artifacts.digest, fixture.registryIndex.packages[0]?.digest);
    assert.deepEqual(artifacts.files, [
      { path: artifact.source, contentBase64: artifact.base64, mode: 0o644 },
    ]);
  });

  test("ingest with a tampered artifact is rejected 422 ARTIFACT_MISMATCH with zero rows written", async (t) => {
    const channel = uniqueChannel();
    const fixture = await buildSignedClosureFixture(t);
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    const artifact = fixtureArtifact(fixture);
    const tampered = Buffer.from(artifact.bytes);
    tampered[0] = tampered[0] === 0x23 ? 0x24 : 0x23;

    await assert.rejects(
      () => ingestClosure(client, trustConfigFromFixture(fixture), {
        registryEnvelope: fixture.registryEnvelope,
        admissionEnvelopes: fixture.admissionEnvelopes,
        channel,
        artifacts: {
          [`${fixture.packageId}@${fixture.packageVersion}`]: { [artifact.source]: tampered.toString("base64") },
        },
      }),
      (error: unknown) => (
        error instanceof ControlPlaneError
        && error.code === "ARTIFACT_MISMATCH"
        && error.httpStatus === 422
      ),
    );

    const { data: packageRows } = await client.from("packages").select("id").eq("id", fixture.packageId);
    assert.deepEqual(packageRows, []);
    const { data: fileRows } = await client.from("package_files").select("path").eq("package_id", fixture.packageId);
    assert.deepEqual(fileRows, []);
    const { data: snapshotRows } = await client.from("registry_snapshots").select("id").eq("channel", channel);
    assert.deepEqual(snapshotRows, []);
  });

  test("ingest with artifacts missing a package is rejected ARTIFACT_MISMATCH", async (t) => {
    const channel = uniqueChannel();
    const fixture = await buildSignedClosureFixture(t);
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    await assert.rejects(
      () => ingestClosure(client, trustConfigFromFixture(fixture), {
        registryEnvelope: fixture.registryEnvelope,
        admissionEnvelopes: fixture.admissionEnvelopes,
        channel,
        artifacts: {},
      }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "ARTIFACT_MISMATCH",
    );

    const { data: packageRows } = await client.from("packages").select("id").eq("id", fixture.packageId);
    assert.deepEqual(packageRows, []);
    const { data: snapshotRows } = await client.from("registry_snapshots").select("id").eq("channel", channel);
    assert.deepEqual(snapshotRows, []);
  });

  test("ingest without artifacts still works and leaves no artifact rows", async (t) => {
    const channel = uniqueChannel();
    const fixture = await buildSignedClosureFixture(t);
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    const result = await ingestClosure(client, trustConfigFromFixture(fixture), {
      registryEnvelope: fixture.registryEnvelope,
      admissionEnvelopes: fixture.admissionEnvelopes,
      channel,
    });
    assert.ok(result.snapshotId.length > 0);

    assert.equal(await getPackageArtifacts(client, fixture.packageId, fixture.packageVersion), undefined);

    const { data: packageRow } = await client
      .from("packages")
      .select("id")
      .eq("id", fixture.packageId)
      .single();
    assert.equal(packageRow?.id, fixture.packageId);
  });

  test("GET /registry/artifacts serves stored artifacts (200) and 404s when absent", async (t) => {
    const auth = await startTestGoogleAuth(t);
    const channel = uniqueChannel();
    const fixture = await buildSignedClosureFixture(t);
    t.after(() => cleanupFixtureRows(client, { channels: [channel], packageIds: [fixture.packageId] }));

    const app = buildServer(client, trustConfigFromFixture(fixture), auth.config);
    t.after(() => app.close());

    const artifact = fixtureArtifact(fixture);

    const ingestResponse = await app.inject({
      method: "POST",
      url: "/registry/ingest",
      payload: {
        registryEnvelope: fixture.registryEnvelope,
        admissionEnvelopes: fixture.admissionEnvelopes,
        channel,
        artifacts: {
          [`${fixture.packageId}@${fixture.packageVersion}`]: { [artifact.source]: artifact.base64 },
        },
      },
      headers: { authorization: bearerHeader(auth) },
    });
    assert.equal(ingestResponse.statusCode, 201);

    const okResponse = await app.inject({
      method: "GET",
      url: `/registry/artifacts/${fixture.packageId}/${fixture.packageVersion}`,
      headers: { authorization: bearerHeader(auth) },
    });
    assert.equal(okResponse.statusCode, 200);
    const body = okResponse.json() as { digest: string; files: Array<{ path: string; contentBase64: string; mode: number }> };
    assert.equal(body.digest, fixture.registryIndex.packages[0]?.digest);
    assert.equal(body.files.length, 1);
    assert.equal(body.files[0]?.path, artifact.source);
    assert.equal(body.files[0]?.contentBase64, artifact.base64);

    const missingResponse = await app.inject({
      method: "GET",
      url: `/registry/artifacts/cipherpol-test-${fixture.suffix}/adapter/does-not-exist/9.9.9`,
      headers: { authorization: bearerHeader(auth) },
    });
    assert.equal(missingResponse.statusCode, 404);
  });
}
