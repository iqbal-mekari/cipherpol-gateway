import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parityManifestV2Schema } from "@cipherpol/contracts";
import { parse } from "yaml";

test("full generated fixture measures the complete software-dev-agentic corpus", async () => {
  const fixture = parse(await readFile(
    resolve("../../fixtures/parity/software-dev-agentic-parity.yaml"),
    "utf8",
  ));
  const parity = parityManifestV2Schema.parse(fixture);
  const measured = {
    userFacing: parity.entries.filter(
      (entry) => entry.artifactType === "orchestrator" && entry.userInvocable === true,
    ).length,
    skills: parity.entries.filter((entry) =>
      entry.artifactType === "orchestrator"
        || entry.artifactType === "internal-procedure"
        || entry.artifactType === "contract"
    ).length,
    agents: parity.entries.filter((entry) => entry.artifactType === "agent").length,
    references: parity.entries.filter((entry) => entry.artifactType === "reference").length,
    cp1Tools: parity.entries.filter((entry) => entry.artifactType === "mcp-tool").length,
    taxonomies: parity.entries.filter((entry) => entry.artifactType === "taxonomy").length,
  };
  assert.deepEqual({
    ...measured,
    classifiedEntries: measured.skills + measured.agents + measured.references + measured.cp1Tools,
  }, {
    userFacing: 34,
    skills: 67,
    agents: 47,
    references: 36,
    cp1Tools: 17,
    taxonomies: 1,
    classifiedEntries: 167,
  });
  assert.equal(parity.entries.length, 168);
});
