import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { generationSchema, registryEnvelopeSchema, type Generation } from "@cipherpol/contracts";
import { materializeGeneration, type ClosureMapping } from "../src/materialize.js";

const FIXTURE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/software-dev-agentic-registry");
// The ground-truth test needs a local clone of the source repo at the admitted
// revision. On developer machines that's /Users/iqbal/projects/software-dev-agentic;
// elsewhere (CI) it's pointed at via SOFTWARE_DEV_AGENTIC_ROOT, exactly like the
// admission corpus test. When it's absent the test skips rather than failing,
// so `pnpm verify` stays hermetic without a live source clone.
const SOURCE_ROOT = process.env.SOFTWARE_DEV_AGENTIC_ROOT ?? "/Users/iqbal/projects/software-dev-agentic";
const ADAPTER_ID = "cipherpol.1/adapter/cp1";

async function loadFixture(): Promise<{
  generation: Generation;
  admissionEnvelopes: Record<string, unknown>;
  closureMappings: ClosureMapping[];
}> {
  const registryEnvelope = registryEnvelopeSchema.parse(
    JSON.parse(await readFile(join(FIXTURE_ROOT, "registry-envelope.json"), "utf8")),
  );

  const generation = generationSchema.parse({
    schemaVersion: "cipherpol.generation/v1",
    generationId: `sha256:${"0".repeat(64)}`,
    project: "software-dev-agentic",
    channel: "stable",
    capabilityPacks: [],
    playbooks: [],
    packages: registryEnvelope.registryIndex.packages,
    toolBundles: [],
    requiredEvidence: [],
  });

  const admissionsRoot = join(FIXTURE_ROOT, "admissions");
  const entries = await readdir(admissionsRoot, { recursive: true });
  const admissionEnvelopes: Record<string, unknown> = {};
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const fullPath = join(admissionsRoot, entry);
    const admissionPath = `admissions/${relative(admissionsRoot, fullPath).split(sep).join("/")}`;
    admissionEnvelopes[admissionPath] = JSON.parse(await readFile(fullPath, "utf8"));
  }

  const closureMappings = registryEnvelope.closureManifest.mappings.map(({ packageId, admissionPath }) => ({
    packageId,
    admissionPath,
  }));

  return { generation, admissionEnvelopes, closureMappings };
}

test("materializeGeneration reproduces the committed artifacts from the source clone", { skip: !existsSync(SOURCE_ROOT) ? "requires the software-dev-agentic source clone (set SOFTWARE_DEV_AGENTIC_ROOT)" : false }, async () => {
  const { generation, admissionEnvelopes, closureMappings } = await loadFixture();
  const outputDir = await mkdtemp(join(tmpdir(), "cipherpol-materialize-"));

  try {
    const result = await materializeGeneration(generation, admissionEnvelopes, closureMappings, SOURCE_ROOT, outputDir);

    // Every one of the 152 packages must digest-verify and be materialized.
    assert.equal(result.materializedPackages, 152);
    assert.equal(result.materializedPackages, generation.packages.length);

    // Ground truth: the adapter's materialized bytes must match the committed
    // artifacts tree byte-for-byte, proving source→artifact anchoring.
    const adapter = generation.packages.find((pkg) => pkg.id === ADAPTER_ID);
    assert.ok(adapter, "adapter package present in the generation");
    const artifactRoot = resolve(FIXTURE_ROOT, adapter.artifactPath);
    for (const entry of adapter.files) {
      const materialized = await readFile(resolve(outputDir, entry.target));
      const committed = await readFile(resolve(artifactRoot, entry.source));
      assert.deepEqual(materialized, committed, `adapter file ${entry.source}`);
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
