import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Generation } from "@cipherpol/contracts";
import { assembleRuntime, CipherpolError, digestDirectory } from "../src/index.js";

async function fixture(): Promise<{ registry: string; output: string; digest: string }> {
  const root = await mkdtemp(join(tmpdir(), "cipherpol-assemble-"));
  const registry = join(root, "registry");
  const artifact = join(registry, "artifacts/task-router");
  await mkdir(artifact, { recursive: true });
  await writeFile(join(artifact, "task-router.md"), "# Task Router\n");
  return { registry, output: join(root, "runtime"), digest: await digestDirectory(artifact) };
}
function generation(digest: string): Generation {
  return {
    schemaVersion: "cipherpol.generation/v1",
    generationId: `sha256:${"b".repeat(64)}`,
    project: "mobile-talenta",
    channel: "stable",
    capabilityPacks: [{ id: "cipherpol.aegis/pack/general", version: "1.0.0" }],
    playbooks: [],
    packages: [{
      id: "cipherpol.aegis/agent/task-router",
      kind: "agent",
      version: "1.0.0",
      digest,
      artifactPath: "artifacts/task-router",
      files: [{ source: "task-router.md", target: "agents/task-router.md" }],
    }],
    toolBundles: [],
    requiredEvidence: [],
  };
}
test("assembles verified content and generation metadata", async () => {
  const data = await fixture();
  await assembleRuntime(generation(data.digest), data.registry, data.output);
  assert.equal(await readFile(join(data.output, "agents/task-router.md"), "utf8"), "# Task Router\n");
  assert.match(await readFile(join(data.output, "cipherpol-generation.json"), "utf8"), /mobile-talenta/);
});
test("rejects artifact tampering before replacing runtime", async () => {
  const data = await fixture();
  await assert.rejects(
    assembleRuntime(generation(`sha256:${"c".repeat(64)}`), data.registry, data.output),
    (error: unknown) => error instanceof CipherpolError && error.code === "ARTIFACT_MISMATCH",
  );
});
test("rejects target collisions", async () => {
  const data = await fixture();
  const duplicate = generation(data.digest);
  duplicate.packages.push({ ...duplicate.packages[0]!, id: "cipherpol.aegis/agent/duplicate" });
  await assert.rejects(
    assembleRuntime(duplicate, data.registry, data.output),
    (error: unknown) => error instanceof CipherpolError && error.code === "TARGET_COLLISION",
  );
});
