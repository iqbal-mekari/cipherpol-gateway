import assert from "node:assert/strict";
import test from "node:test";
import {
  cipherpolManifestSchema,
  packageRecordSchema,
  parityManifestSchema,
} from "../src/index.js";

const validPackage = {
  id: "cipherpol.aegis/agent/task-router",
  kind: "agent",
  version: "1.0.0",
  digest: `sha256:${"a".repeat(64)}`,
  owner: "mobile-platform",
  sourceRevision: "0123456789abcdef",
  artifactPath: "artifacts/task-router",
  compatibility: { claudeCode: ">=2.1.0", capabilities: ["plugins"] },
  dependencies: [],
  files: [{ source: "task-router.md", target: "agents/task-router.md" }],
};

test("requires namespaced package IDs", () => {
  assert.equal(packageRecordSchema.parse(validPackage).id, validPackage.id);
  assert.throws(() => packageRecordSchema.parse({ ...validPackage, id: "task-router" }));
});

test("rejects traversal in mapped files", () => {
  assert.throws(() => packageRecordSchema.parse({
    ...validPackage,
    files: [{ source: "task-router.md", target: "../task-router.md" }],
  }));
});

test("requires exact pins for the pinned channel", () => {
  assert.throws(() => cipherpolManifestSchema.parse({
    schemaVersion: "cipherpol.mekari.com/v1",
    project: "mobile-talenta",
    platforms: ["flutter"],
    channel: "pinned",
    capabilityPacks: ["cipherpol.aegis/pack/general"],
    playbooks: [],
    policyProfile: "standard",
    owners: ["mobile-platform"],
  }));
});

test("parity entries cannot silently use generic fallback", () => {
  assert.throws(() => parityManifestSchema.parse({
    schemaVersion: "cipherpol.parity/v1",
    sourceMarketplaceRevision: "0123456789abcdef",
    baseline: { userFacing: 34, skills: 67, agents: 47, references: 36, cp1Tools: 17 },
    entries: [{
      id: "cipherpol.aegis/skill/developer-plan-feature",
      sourcePath: "cipherpol-aegis/lib/developer/skills/orchestrators/developer-plan-feature/SKILL.md",
      artifactType: "orchestrator",
      shipped: true,
      state: "generic-fallback",
      evidence: [],
    }],
  }));
});
