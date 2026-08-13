import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parityManifestSchema } from "@cipherpol/contracts";
import { parse } from "yaml";

test("fixture preserves the complete software-dev-agentic baseline counts", async () => {
  const fixture = parse(await readFile(resolve("../../fixtures/parity/minimal-parity.yaml"), "utf8"));
  const parity = parityManifestSchema.parse(fixture);
  assert.deepEqual(parity.baseline, {
    userFacing: 34,
    skills: 67,
    agents: 47,
    references: 36,
    cp1Tools: 17,
  });
});
