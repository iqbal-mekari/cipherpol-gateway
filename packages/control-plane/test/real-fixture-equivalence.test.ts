import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { canonicalJson, type CipherpolManifest, type PackageRecord } from "@cipherpol/contracts";
import { CipherpolError, resolveGeneration } from "@cipherpol/resolver";
import { ingestClosure, type ControlPlaneTrustConfig } from "../src/ingest.js";
import { listPackages } from "../src/registry-reads.js";
import { loadCurrentRegistryIndex } from "../src/canonical-registry.js";
import { resolveGenerationFromRegistry } from "../src/generations.js";
import { ControlPlaneError } from "../src/errors.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const registryRoot = join(repoRoot, "fixtures/software-dev-agentic-registry");
const fixtureKeyId = "fixture.stage2.software-dev-agentic";
const fixtureSourceRevision = "a8afa8dd0848833b72ef536e1258d5c27bb8e3fc";
const channel = "pinned";

async function readAdmissionEnvelopes(): Promise<Record<string, unknown>> {
  const admissionsRoot = join(registryRoot, "admissions");
  const envelopes: Record<string, unknown> = {};

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      const admissionPath = relative(registryRoot, entryPath).split("\\").join("/");
      envelopes[admissionPath] = JSON.parse(await readFile(entryPath, "utf8"));
    }
  }

  await walk(admissionsRoot);
  return envelopes;
}

function sortPackages(packages: readonly PackageRecord[]): PackageRecord[] {
  return [...packages].sort((left, right) => {
    const idOrder = left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    return idOrder !== 0 ? idOrder : (left.version < right.version ? -1 : left.version > right.version ? 1 : 0);
  });
}

const supabaseUrl = process.env["SUPABASE_URL"];
const supabaseServiceRoleKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];

test(
  "ingests the real 152-package Stage 2 closure fixture and matches it exactly on read-back",
  { skip: supabaseUrl === undefined || supabaseServiceRoleKey === undefined ? "SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are not set" : false },
  async (context) => {
    const client = createClient(supabaseUrl!, supabaseServiceRoleKey!);
    const registryEnvelope = JSON.parse(await readFile(join(registryRoot, "registry-envelope.json"), "utf8")) as {
      registryIndex: { packages: readonly PackageRecord[] };
    };
    const admissionEnvelopes = await readAdmissionEnvelopes();
    const trustedPublicKeyPem = await readFile(
      join(repoRoot, "fixtures/software-dev-agentic/stage2-fixture-public.pem"),
      "utf8",
    );

    const sourcePackages = registryEnvelope.registryIndex.packages;
    assert.equal(sourcePackages.length, 152, "the committed real fixture must itself contain exactly 152 packages");
    const sourceIds = [...new Set(sourcePackages.map((record) => record.id))];
    const idBatchSize = 40;

    context.after(async () => {
      await client.from("registry_snapshots").delete().eq("channel", channel).eq("source_revision", fixtureSourceRevision);
      for (let offset = 0; offset < sourceIds.length; offset += idBatchSize) {
        const batch = sourceIds.slice(offset, offset + idBatchSize);
        await client.from("packages").delete().in("id", batch);
      }
    });

    const trust: ControlPlaneTrustConfig = {
      trustedKeyId: fixtureKeyId,
      trustedPublicKeyPem,
      trustedKeyPurpose: "fixture",
      allowFixtureKeys: true,
    };
    const result = await ingestClosure(client, trust, { registryEnvelope, admissionEnvelopes, channel });
    assert.ok(result.snapshotId.length > 0);

    let tableRowCount = 0;
    for (let offset = 0; offset < sourceIds.length; offset += idBatchSize) {
      const batch = sourceIds.slice(offset, offset + idBatchSize);
      const { count, error: countError } = await client
        .from("packages")
        .select("id", { count: "exact", head: true })
        .in("id", batch);
      assert.equal(countError, null);
      tableRowCount += count ?? 0;
    }
    assert.equal(tableRowCount, 152, "exactly 152 rows for the fixture's package IDs must be persisted in the packages table");

    const persisted = await listPackages(client, channel);
    assert.ok(persisted !== undefined);
    assert.equal(persisted!.length, 152);
    assert.equal(
      canonicalJson(sortPackages(persisted!)),
      canonicalJson(sortPackages(sourcePackages)),
      "read-back packages must be byte-equivalent to the source fixture's registry index",
    );

    const current = await loadCurrentRegistryIndex(client, channel);
    assert.ok(current !== undefined);
    assert.equal(current!.index.capabilityPacks.length, 0, "the real Stage 2 corpus ships zero capability packs by design");
    assert.equal(current!.index.playbooks.length, 0, "the real Stage 2 corpus ships zero playbooks by design");

    const manifest: CipherpolManifest = {
      schemaVersion: "cipherpol.mekari.com/v1",
      project: "stage3-real-fixture-equivalence",
      platforms: ["flutter"],
      channel,
      capabilityPacks: ["cipherpol.aegis/pack/general"],
      playbooks: [],
      policyProfile: "standard",
      owners: ["mobile-platform"],
    };
    const resolverClient = { claudeCodeVersion: "2.1.89", capabilities: new Set(["plugins"]) };

    let controlPlaneFailureCode: string | undefined;
    try {
      await resolveGenerationFromRegistry(client, manifest, resolverClient);
    } catch (error) {
      assert.ok(error instanceof ControlPlaneError);
      controlPlaneFailureCode = (error as ControlPlaneError).code;
    }
    assert.equal(controlPlaneFailureCode, "RESOLUTION_FAILED");

    let directFailureCode: string | undefined;
    try {
      resolveGeneration(manifest, current!.index, resolverClient);
    } catch (error) {
      assert.ok(error instanceof CipherpolError);
      directFailureCode = (error as CipherpolError).code;
    }
    assert.equal(
      directFailureCode,
      "UNRESOLVABLE_GENERATION",
      "resolving directly against the exact same persisted index must fail identically to the control-plane path",
    );
  },
);
