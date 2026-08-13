import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CipherpolError, loadManifest } from "../src/index.js";

async function manifest(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cipherpol-load-"));
  const path = join(directory, "cipherpol.yaml");
  await writeFile(path, content);
  return path;
}

test("loads a valid manifest", async () => {
  const path = await manifest(`schemaVersion: cipherpol.mekari.com/v1
project: mobile-talenta
platforms: [flutter]
channel: stable
capabilityPacks: [cipherpol.aegis/pack/general]
playbooks: []
policyProfile: standard
owners: [mobile-platform]
`);
  assert.equal((await loadManifest(path)).project, "mobile-talenta");
});

test("uses a stable error for invalid input", async () => {
  await assert.rejects(loadManifest(await manifest("project: mobile-talenta\n")),
    (error: unknown) => error instanceof CipherpolError && error.code === "INVALID_MANIFEST");
});
