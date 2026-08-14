import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { CipherpolAdmissionError } from "../src/errors.js";
import type { ImportedArtifactDescriptor, SoftwareDevAgenticImportResult } from "../src/importer.js";
import type { SoftwareDevAgenticImportPolicy } from "../src/import-policy.js";
import { materializeClosure, type MaterializedClosure } from "../src/materialize.js";
import { generatePackageInputs } from "../src/package-records.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures/closure-source", import.meta.url));
const sourceRevision = "abc1234567";
const sourceRepository = "https://example.test/software-dev-agentic.git";

const skillDescriptor: ImportedArtifactDescriptor = {
  packageId: "cipherpol.aegis/skill/demo",
  parityIds: ["cipherpol.aegis/orchestrator/demo"],
  module: "cipherpol-aegis",
  moduleVersion: "16.0.1",
  packageKind: "skill",
  sourceKind: "directory",
  sourcePaths: ["cipherpol-aegis/skills/demo"],
  targetRoot: "skills/demo",
};

const agentDescriptor: ImportedArtifactDescriptor = {
  packageId: "cipherpol.aegis/agent/worker",
  parityIds: ["cipherpol.aegis/agent/worker"],
  module: "cipherpol-aegis",
  moduleVersion: "16.0.1",
  packageKind: "agent",
  sourceKind: "file",
  sourcePaths: ["cipherpol-aegis/agents/worker.md"],
  targetRoot: "agents/worker.md",
};

const referenceDescriptor: ImportedArtifactDescriptor = {
  packageId: "cipherpol.aegis/reference/guide",
  parityIds: ["cipherpol.aegis/reference/guide"],
  module: "cipherpol-aegis",
  moduleVersion: "16.0.1",
  packageKind: "reference",
  sourceKind: "file",
  sourcePaths: ["cipherpol-aegis/reference/guide.md"],
  targetRoot: "reference/guide.md",
};

const adapterDescriptor: ImportedArtifactDescriptor = {
  packageId: "cipherpol.1/adapter/cp1",
  parityIds: ["cipherpol.1/mcp-tool/portable"],
  module: "cipherpol-1",
  moduleVersion: "0.2.0",
  packageKind: "adapter",
  sourceKind: "cp1-adapter",
  sourcePaths: [
    "cipherpol-1/package.json",
    "cipherpol-1/deploy",
    "cipherpol-1/packages/server/src",
  ],
  targetRoot: ".",
};

const moduleVersions = {
  "cipherpol-aegis": "16.0.1",
  "cipherpol-9": "13.14.0",
  "cipherpol-1": "0.2.0",
};

function importedWith(artifacts: readonly ImportedArtifactDescriptor[]): SoftwareDevAgenticImportResult {
  return {
    sourceRevision,
    moduleVersions,
    entries: [],
    manifest: undefined,
    measured: undefined,
    artifacts,
  } as unknown as SoftwareDevAgenticImportResult;
}

function validPolicy(): SoftwareDevAgenticImportPolicy {
  const module = { owner: "mobile-platform", packageVersion: "module-version" as const, claudeCode: ">=2.1.0 <3.0.0", capabilities: ["plugins"] };
  return {
    schemaVersion: "cipherpol.import-policy/v1",
    modules: {
      "cipherpol-aegis": module,
      "cipherpol-9": module,
      "cipherpol-1": module,
    },
    packageDependencies: {},
  };
}

async function outputDirectory(t: TestContext): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "cipherpol-package-records-"));
  const output = join(parent, "closure");
  t.after(() => rm(parent, { recursive: true, force: true }));
  return output;
}

function assertAdmissionCode(error: unknown, code: CipherpolAdmissionError["code"]): boolean {
  assert.ok(error instanceof CipherpolAdmissionError);
  assert.equal(error.code, code);
  return true;
}

test("derives package inputs only from descriptor, policy, and measured files", async (t) => {
  const materialized = await materializeClosure({
    sourceRoot: fixtureRoot,
    outputRoot: await outputDirectory(t),
    imported: importedWith([skillDescriptor, agentDescriptor, referenceDescriptor, adapterDescriptor]),
  });
  const policy: SoftwareDevAgenticImportPolicy = {
    ...validPolicy(),
    packageDependencies: {
      "cipherpol.aegis/reference/guide": ["cipherpol.aegis/skill/demo@^16.0.0"],
    },
  };

  const records = generatePackageInputs({
    imported: importedWith([skillDescriptor, agentDescriptor, referenceDescriptor, adapterDescriptor]),
    materialized,
    policy,
    sourceRepository,
  });

  assert.equal(records.length, 4);
  assert.deepEqual(records.map((record) => record.input.id), [
    "cipherpol.1/adapter/cp1",
    "cipherpol.aegis/agent/worker",
    "cipherpol.aegis/reference/guide",
    "cipherpol.aegis/skill/demo",
  ]);

  const skillPackage = materialized.packages.find((item) => item.descriptor.packageId === skillDescriptor.packageId);
  assert.ok(skillPackage);
  const skillRecord = records.find((record) => record.input.id === skillDescriptor.packageId);
  assert.ok(skillRecord);
  assert.equal(skillRecord.input.kind, "skill");
  assert.equal(skillRecord.input.version, "16.0.1");
  assert.equal(skillRecord.input.owner, "mobile-platform");
  assert.equal(skillRecord.input.sourceRevision, sourceRevision);
  assert.equal(skillRecord.input.artifactPath, skillPackage.artifactPath);
  assert.equal(skillRecord.artifactRoot, skillPackage.artifactRoot);
  assert.deepEqual(skillRecord.input.compatibility, { claudeCode: ">=2.1.0 <3.0.0", capabilities: ["plugins"] });
  assert.deepEqual(skillRecord.input.dependencies, []);
  assert.deepEqual(skillRecord.input.files, skillPackage.files);
  assert.deepEqual(skillRecord.input.provenance, {
    sourceRepository,
    sourceRevision,
    sourcePaths: skillDescriptor.sourcePaths,
  });

  const referenceRecord = records.find((record) => record.input.id === referenceDescriptor.packageId);
  assert.ok(referenceRecord);
  assert.deepEqual(referenceRecord.input.dependencies, ["cipherpol.aegis/skill/demo@^16.0.0"]);

  const adapterRecord = records.find((record) => record.input.id === adapterDescriptor.packageId);
  assert.ok(adapterRecord);
  assert.equal(adapterRecord.input.version, "0.2.0");
  assert.equal(adapterRecord.input.kind, "adapter");
});

test("rejects a descriptor whose module has no policy entry", async (t) => {
  const materialized = await materializeClosure({
    sourceRoot: fixtureRoot,
    outputRoot: await outputDirectory(t),
    imported: importedWith([adapterDescriptor]),
  });
  const { "cipherpol-1": _removed, ...remainingModules } = validPolicy().modules;
  const policy = { ...validPolicy(), modules: remainingModules } as unknown as SoftwareDevAgenticImportPolicy;

  assert.throws(
    () => generatePackageInputs({
      imported: importedWith([adapterDescriptor]),
      materialized,
      policy,
      sourceRepository,
    }),
    (error) => assertAdmissionCode(error, "INVALID_ADMISSION"),
  );
});

test("rejects a policy module declaring an unsupported package-version mode", async (t) => {
  const materialized = await materializeClosure({
    sourceRoot: fixtureRoot,
    outputRoot: await outputDirectory(t),
    imported: importedWith([skillDescriptor]),
  });
  const basePolicy = validPolicy();
  const policy = {
    ...basePolicy,
    modules: {
      ...basePolicy.modules,
      "cipherpol-aegis": { ...basePolicy.modules["cipherpol-aegis"], packageVersion: "16.0.1" },
    },
  } as unknown as SoftwareDevAgenticImportPolicy;

  assert.throws(
    () => generatePackageInputs({
      imported: importedWith([skillDescriptor]),
      materialized,
      policy,
      sourceRepository,
    }),
    (error) => assertAdmissionCode(error, "INVALID_ADMISSION"),
  );
});

test("rejects a policy dependency referencing an unknown package ID", async (t) => {
  const materialized = await materializeClosure({
    sourceRoot: fixtureRoot,
    outputRoot: await outputDirectory(t),
    imported: importedWith([skillDescriptor]),
  });
  const policy: SoftwareDevAgenticImportPolicy = {
    ...validPolicy(),
    packageDependencies: {
      "cipherpol.aegis/skill/demo": ["cipherpol.aegis/reference/missing@1.0.0"],
    },
  };

  assert.throws(
    () => generatePackageInputs({
      imported: importedWith([skillDescriptor]),
      materialized,
      policy,
      sourceRepository,
    }),
    (error) => assertAdmissionCode(error, "MISSING_DEPENDENCY"),
  );
});

test("rejects a self-referential policy dependency", async (t) => {
  const materialized = await materializeClosure({
    sourceRoot: fixtureRoot,
    outputRoot: await outputDirectory(t),
    imported: importedWith([skillDescriptor]),
  });
  const policy: SoftwareDevAgenticImportPolicy = {
    ...validPolicy(),
    packageDependencies: {
      "cipherpol.aegis/skill/demo": ["cipherpol.aegis/skill/demo@1.0.0"],
    },
  };

  assert.throws(
    () => generatePackageInputs({
      imported: importedWith([skillDescriptor]),
      materialized,
      policy,
      sourceRepository,
    }),
    (error) => assertAdmissionCode(error, "DEPENDENCY_CYCLE"),
  );
});

test("rejects a target/kind mismatch between the descriptor kind and its materialized target", async (t) => {
  const mislabeledDescriptor: ImportedArtifactDescriptor = {
    ...referenceDescriptor,
    packageId: "cipherpol.aegis/reference/mislabeled",
    packageKind: "reference",
    targetRoot: "agents/mislabeled.md",
  };
  const materialized = await materializeClosure({
    sourceRoot: fixtureRoot,
    outputRoot: await outputDirectory(t),
    imported: importedWith([mislabeledDescriptor]),
  });
  const policy = validPolicy();

  assert.throws(
    () => generatePackageInputs({
      imported: importedWith([mislabeledDescriptor]),
      materialized,
      policy,
      sourceRepository,
    }),
    (error) => assertAdmissionCode(error, "INVALID_AGENT_CONTEXT"),
  );
});

test("rejects a materialized file with an invalid mode", () => {
  const fakeMaterialized: MaterializedClosure = {
    root: "/tmp/cipherpol-fake-root",
    skillsDirectory: "/tmp/cipherpol-fake-root/.gates/skills",
    agentsDirectory: "/tmp/cipherpol-fake-root/.gates/agents",
    packages: [{
      descriptor: referenceDescriptor,
      artifactRoot: "/tmp/cipherpol-fake-root/artifacts/reference",
      artifactPath: "artifacts/reference",
      files: [{ source: "guide.md", target: "reference/guide.md", mode: 0o600 as unknown as 0o644 }],
    }],
  };
  const policy = validPolicy();

  assert.throws(
    () => generatePackageInputs({
      imported: importedWith([referenceDescriptor]),
      materialized: fakeMaterialized,
      policy,
      sourceRepository,
    }),
    (error) => assertAdmissionCode(error, "INVALID_ADMISSION"),
  );
});

test("rejects a module-version mismatch between the descriptor and the imported pin", async (t) => {
  const materialized = await materializeClosure({
    sourceRoot: fixtureRoot,
    outputRoot: await outputDirectory(t),
    imported: importedWith([skillDescriptor]),
  });
  const policy = validPolicy();
  const mismatchedImported = {
    sourceRevision,
    moduleVersions: { ...moduleVersions, "cipherpol-aegis": "99.0.0" },
    entries: [],
    manifest: undefined,
    measured: undefined,
    artifacts: [skillDescriptor],
  } as unknown as SoftwareDevAgenticImportResult;

  assert.throws(
    () => generatePackageInputs({
      imported: mismatchedImported,
      materialized,
      policy,
      sourceRepository,
    }),
    (error) => assertAdmissionCode(error, "PROVENANCE_MISMATCH"),
  );
});
