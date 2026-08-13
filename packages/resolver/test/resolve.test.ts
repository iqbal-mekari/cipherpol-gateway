import assert from "node:assert/strict";
import test from "node:test";
import type { CipherpolManifest, PackageRecord, RegistryIndex } from "@cipherpol/contracts";
import { CipherpolError, resolveGeneration } from "../src/index.js";

const manifest: CipherpolManifest = {
  schemaVersion: "cipherpol.mekari.com/v1",
  project: "mobile-talenta",
  platforms: ["flutter"],
  channel: "stable",
  capabilityPacks: ["cipherpol.aegis/pack/general"],
  playbooks: [],
  policyProfile: "standard",
  owners: ["mobile-platform"],
};
const client = { claudeCodeVersion: "2.1.89", capabilities: new Set(["plugins"]) };

function packageRecord(version: string, revoked = false): PackageRecord {
  return {
    id: "cipherpol.aegis/agent/task-router",
    kind: "agent",
    version,
    digest: `sha256:${"a".repeat(64)}`,
    owner: "mobile-platform",
    sourceRevision: "0123456789abcdef",
    artifactPath: `artifacts/task-router-${version}`,
    compatibility: { claudeCode: ">=2.1.0 <3.0.0", capabilities: ["plugins"] },
    dependencies: [],
    files: [{ source: "task-router.md", target: "agents/task-router.md" }],
    revoked,
  };
}

function registryWith(...versions: string[]): RegistryIndex {
  return {
    schemaVersion: "cipherpol.registry/v1",
    packages: versions.map((version) => packageRecord(version)),
    capabilityPacks: [{
      id: "cipherpol.aegis/pack/general",
      version: "1.0.0",
      intents: ["mobile-development"],
      platforms: ["flutter", "android", "ios", "web-nextjs", "generic"],
      orchestrator: "cipherpol.aegis/agent/task-router@^1.0.0",
      packages: ["cipherpol.aegis/agent/task-router@^1.0.0"],
      playbooks: [],
      requiredEvidence: ["focused-validation"],
      revoked: false,
    }],
    playbooks: [],
  };
}

test("selects the highest compatible package", () => {
  assert.equal(resolveGeneration(manifest, registryWith("1.0.0", "1.2.0"), client).packages[0]?.version, "1.2.0");
});

test("resolution is independent of registry order", () => {
  assert.deepEqual(
    resolveGeneration(manifest, registryWith("1.0.0", "1.2.0"), client),
    resolveGeneration(manifest, registryWith("1.2.0", "1.0.0"), client),
  );
});

test("revoked packages cannot resolve", () => {
  const registry = registryWith("1.2.0");
  registry.packages = [packageRecord("1.2.0", true)];
  assert.throws(
    () => resolveGeneration(manifest, registry, client),
    (error: unknown) => error instanceof CipherpolError && error.code === "UNRESOLVABLE_GENERATION",
  );
});

test("required client capabilities are enforced", () => {
  assert.throws(
    () => resolveGeneration(manifest, registryWith("1.2.0"), {
      claudeCodeVersion: "2.1.89",
      capabilities: new Set(),
    }),
    (error: unknown) => error instanceof CipherpolError && error.code === "UNRESOLVABLE_GENERATION",
  );
});
