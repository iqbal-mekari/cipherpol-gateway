import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { CipherpolAdmissionError } from "../src/errors.js";
import {
  loadImportPolicy,
  validateImportPolicyPackageDependencies,
} from "../src/import-policy.js";

const checkedInPolicyPath = fileURLToPath(
  new URL("../../../fixtures/software-dev-agentic/import-policy.yaml", import.meta.url),
);

const validPolicy = `schemaVersion: cipherpol.import-policy/v1
modules:
  cipherpol-aegis:
    owner: mobile-platform
    packageVersion: module-version
    claudeCode: ">=2.1.0 <3.0.0"
    capabilities: [plugins]
  cipherpol-9:
    owner: mobile-platform
    packageVersion: module-version
    claudeCode: ">=2.1.0 <3.0.0"
    capabilities: [plugins]
  cipherpol-1:
    owner: mobile-platform
    packageVersion: module-version
    claudeCode: ">=2.1.0 <3.0.0"
    capabilities: [plugins]
packageDependencies: {}
`;

async function writePolicy(t: TestContext, source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cipherpol-import-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "import-policy.yaml");
  await writeFile(path, source);
  return path;
}

function assertAdmissionCode(error: unknown, code: CipherpolAdmissionError["code"]): boolean {
  assert.ok(error instanceof CipherpolAdmissionError);
  assert.equal(error.code, code);
  return true;
}

test("loads all explicit module metadata from the checked-in policy", async () => {
  const policy = await loadImportPolicy(checkedInPolicyPath);
  assert.equal(policy.schemaVersion, "cipherpol.import-policy/v1");
  assert.deepEqual(Object.keys(policy.modules).sort(), ["cipherpol-1", "cipherpol-9", "cipherpol-aegis"]);
  for (const module of Object.values(policy.modules)) {
    assert.equal(module.owner, "mobile-platform");
    assert.equal(module.packageVersion, "module-version");
    assert.equal(module.claudeCode, ">=2.1.0 <3.0.0");
    assert.deepEqual(module.capabilities, ["plugins"]);
  }
  assert.deepEqual(policy.packageDependencies, {});
});

test("rejects a missing module policy", async (t) => {
  const path = await writePolicy(t, validPolicy.replace(/  cipherpol-1:\n(?:    .*\n){4}/, ""));
  await assert.rejects(loadImportPolicy(path), (error) => assertAdmissionCode(error, "INVALID_ADMISSION"));
});

test("rejects unknown module and top-level fields", async (t) => {
  const path = await writePolicy(t, validPolicy.replace(
    "packageDependencies: {}",
    "  cipherpol-extra:\n    owner: mobile-platform\n    packageVersion: module-version\n    claudeCode: ^2.1.0\n    capabilities: [plugins]\npackageDependencies: {}\nunexpected: true",
  ));
  await assert.rejects(loadImportPolicy(path), (error) => assertAdmissionCode(error, "INVALID_ADMISSION"));
});

test("rejects invalid module compatibility and duplicate capabilities", async (t) => {
  const invalidRange = await writePolicy(t, validPolicy.replace(">=2.1.0 <3.0.0", "not-semver"));
  await assert.rejects(loadImportPolicy(invalidRange), (error) => assertAdmissionCode(error, "INVALID_ADMISSION"));

  const duplicateCapability = await writePolicy(t, validPolicy.replace("capabilities: [plugins]", "capabilities: [plugins, plugins]"));
  await assert.rejects(loadImportPolicy(duplicateCapability), (error) => assertAdmissionCode(error, "INVALID_ADMISSION"));
});

test("loads exact dependency references and validates them against imported package IDs", async (t) => {
  const path = await writePolicy(t, validPolicy.replace(
    "packageDependencies: {}",
    "packageDependencies:\n  cipherpol.aegis/orchestrator/demo-command:\n    - cipherpol.aegis/internal-procedure/demo-procedure@^16.0.0",
  ));
  const policy = await loadImportPolicy(path);
  assert.deepEqual(policy.packageDependencies, {
    "cipherpol.aegis/orchestrator/demo-command": [
      "cipherpol.aegis/internal-procedure/demo-procedure@^16.0.0",
    ],
  });
  validateImportPolicyPackageDependencies(policy, [
    "cipherpol.aegis/orchestrator/demo-command",
    "cipherpol.aegis/internal-procedure/demo-procedure",
  ]);
  assert.throws(
    () => validateImportPolicyPackageDependencies(policy, ["cipherpol.aegis/orchestrator/demo-command"]),
    (error) => assertAdmissionCode(error, "MISSING_DEPENDENCY"),
  );
});

test("rejects malformed dependency ranges", async (t) => {
  const path = await writePolicy(t, validPolicy.replace(
    "packageDependencies: {}",
    "packageDependencies:\n  cipherpol.aegis/orchestrator/demo-command:\n    - cipherpol.aegis/internal-procedure/demo-procedure@not-semver",
  ));
  await assert.rejects(loadImportPolicy(path), (error) => assertAdmissionCode(error, "INVALID_REFERENCE"));
});

test("rejects cyclic explicit package dependencies", async (t) => {
  const path = await writePolicy(t, validPolicy.replace(
    "packageDependencies: {}",
    `packageDependencies:
  cipherpol.aegis/orchestrator/one:
    - cipherpol.aegis/orchestrator/two@16.0.1
  cipherpol.aegis/orchestrator/two:
    - cipherpol.aegis/orchestrator/one@16.0.1`,
  ));
  await assert.rejects(loadImportPolicy(path), (error) => assertAdmissionCode(error, "DEPENDENCY_CYCLE"));
});

test("rejects YAML aliases and duplicate keys", async (t) => {
  const aliasPath = await writePolicy(t, validPolicy.replace(
    "capabilities: [plugins]",
    "capabilities: &capabilities [plugins]",
  ).replace("capabilities: [plugins]", "capabilities: *capabilities"));
  await assert.rejects(loadImportPolicy(aliasPath), (error) => assertAdmissionCode(error, "INVALID_ADMISSION"));

  const duplicatePath = await writePolicy(t, `${validPolicy}schemaVersion: cipherpol.import-policy/v1\n`);
  await assert.rejects(loadImportPolicy(duplicatePath), (error) => assertAdmissionCode(error, "INVALID_ADMISSION"));
});
