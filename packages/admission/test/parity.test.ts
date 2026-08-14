import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import test from "node:test";
import { parityEntryV2Schema, parityManifestV2Schema } from "@cipherpol/contracts";
import { parse } from "yaml";
import { importSoftwareDevAgenticArtifacts, measureSoftwareDevAgenticCorpus } from "../src/importer.js";
import { measureParityEntries, verifyParityBaseline } from "../src/parity.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures/software-dev-agentic", import.meta.url));
const revision = "0123456789abcdef";

test("builds schema-valid evidence-rich parity from fixture sources", async () => {
  const result = await importSoftwareDevAgenticArtifacts({ repositoryRoot: fixtureRoot, sourceRevision: revision });
  assert.ok(result.entries.every((entry) => parityEntryV2Schema.safeParse(entry).success));
  assert.ok(result.entries.every((entry) => entry.shipped && entry.evidence.length > 0));
  assert.throws(() => verifyParityBaseline(result.manifest), { name: "CipherpolAdmissionError" });
});

test("measures all 168 entries in the full generated parity fixture", async () => {
  const fixture = parse(await readFile(
    resolve("../../fixtures/parity/software-dev-agentic-parity.yaml"),
    "utf8",
  ));
  const manifest = parityManifestV2Schema.parse(fixture);
  assert.deepEqual(measureParityEntries(manifest.entries), {
    userFacing: 34,
    skills: 67,
    agents: 47,
    references: 36,
    cp1Tools: 17,
    classifiedEntries: 167,
    taxonomies: 1,
  });
  assert.equal(manifest.entries.length, 168);
});

const integrationRoot = process.env.SOFTWARE_DEV_AGENTIC_ROOT;
test("measures the opt-in real software-dev-agentic corpus", {
  skip: integrationRoot === undefined ? "set SOFTWARE_DEV_AGENTIC_ROOT to run source integration" : false,
}, async () => {
  assert.ok(integrationRoot);
  const result = await measureSoftwareDevAgenticCorpus({
    repositoryRoot: integrationRoot,
    sourceRevision: process.env.SOFTWARE_DEV_AGENTIC_REVISION ?? revision,
  });
  assert.deepEqual(result.measured, {
    userFacing: 34,
    skills: 67,
    agents: 47,
    references: 36,
    cp1Tools: 17,
    classifiedEntries: 167,
    taxonomies: 1,
  });
  assert.equal(result.entries.length, 168);
});
