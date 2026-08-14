import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  cp,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { CipherpolAdmissionError } from "../src/errors.js";
import {
  importSoftwareDevAgenticArtifacts,
  type ImportedArtifactDescriptor,
  type SoftwareDevAgenticImportResult,
} from "../src/importer.js";
import { materializeClosure, type MaterializedPackage } from "../src/materialize.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures/closure-source", import.meta.url));

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

const taxonomyDescriptor: ImportedArtifactDescriptor = {
  packageId: "cipherpol.aegis/reference/taxonomy",
  parityIds: ["cipherpol.aegis/taxonomy/root"],
  module: "cipherpol-aegis",
  moduleVersion: "16.0.1",
  packageKind: "reference",
  sourceKind: "file",
  sourcePaths: ["cipherpol.json"],
  targetRoot: "reference/cipherpol.json",
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

function importedWith(
  artifacts: readonly ImportedArtifactDescriptor[],
): SoftwareDevAgenticImportResult {
  return { artifacts } as unknown as SoftwareDevAgenticImportResult;
}

async function outputDirectory(t: TestContext, prefix = "cipherpol-materialize-"): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  const output = join(parent, "closure");
  t.after(() => rm(parent, { recursive: true, force: true }));
  return output;
}

async function mutableFixture(t: TestContext, baseDir: string = tmpdir()): Promise<string> {
  const root = await mkdtemp(join(baseDir, "cipherpol-materialize-source-"));
  await cp(fixtureRoot, root, { recursive: true, preserveTimestamps: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function assertAdmissionCode(error: unknown, code: CipherpolAdmissionError["code"]): boolean {
  assert.ok(error instanceof CipherpolAdmissionError);
  assert.equal(error.code, code);
  return true;
}

function persistedPackageView(materializedPackage: MaterializedPackage): object {
  return {
    descriptor: materializedPackage.descriptor,
    artifactPath: materializedPackage.artifactPath,
    files: materializedPackage.files,
  };
}

async function regularFilePaths(root: string, directory = ""): Promise<string[]> {
  const absoluteDirectory = directory === "" ? root : join(root, ...directory.split("/"));
  const children = await readdir(absoluteDirectory, { withFileTypes: true });
  const paths: string[] = [];
  for (const child of children) {
    const path = directory === "" ? child.name : `${directory}/${child.name}`;
    if (child.isDirectory()) {
      paths.push(...await regularFilePaths(root, path));
    } else if (child.isFile()) {
      paths.push(path);
    }
  }
  return paths.sort();
}

test("materializes complete package directories, normalized modes, and exact gate views", async (t) => {
  const outputRoot = await outputDirectory(t);
  const result = await materializeClosure({
    sourceRoot: fixtureRoot,
    outputRoot,
    imported: importedWith([
      skillDescriptor,
      agentDescriptor,
      referenceDescriptor,
      taxonomyDescriptor,
      adapterDescriptor,
    ]),
  });

  assert.equal(result.packages.length, 5);
  const skill = result.packages.find((item) => item.descriptor.packageId === skillDescriptor.packageId);
  assert.ok(skill);
  assert.equal(
    skill.artifactPath,
    "artifacts/cipherpol.aegis/skill/demo/16.0.1",
  );
  assert.deepEqual(skill.files, [
    { source: "SKILL.md", target: "skills/demo/SKILL.md", mode: 0o644 },
    { source: "procedure.md", target: "skills/demo/procedure.md", mode: 0o644 },
    { source: "prompts/helper.txt", target: "skills/demo/prompts/helper.txt", mode: 0o644 },
    { source: "scripts/run.sh", target: "skills/demo/scripts/run.sh", mode: 0o755 },
  ]);
  assert.equal(
    await readFile(join(skill.artifactRoot, "prompts/helper.txt"), "utf8"),
    "This auxiliary prompt must survive complete-directory materialization.\n",
  );
  assert.equal(
    await readFile(join(result.skillsDirectory, "demo/prompts/helper.txt"), "utf8"),
    "This auxiliary prompt must survive complete-directory materialization.\n",
  );
  assert.equal(
    await readFile(join(result.agentsDirectory, "worker.md"), "utf8"),
    await readFile(join(fixtureRoot, "cipherpol-aegis/agents/worker.md"), "utf8"),
  );
  assert.equal((await lstat(join(skill.artifactRoot, "SKILL.md"))).mode & 0o777, 0o644);
  assert.equal((await lstat(join(skill.artifactRoot, "scripts/run.sh"))).mode & 0o777, 0o755);
  assert.equal((await lstat(join(result.skillsDirectory, "demo/scripts/run.sh"))).mode & 0o777, 0o755);
  assert.deepEqual(await regularFilePaths(result.skillsDirectory), [
    "demo/SKILL.md",
    "demo/procedure.md",
    "demo/prompts/helper.txt",
    "demo/scripts/run.sh",
  ]);
  assert.deepEqual(await regularFilePaths(result.agentsDirectory), ["worker.md"]);

  const agent = result.packages.find((item) => item.descriptor.packageId === agentDescriptor.packageId);
  assert.ok(agent);
  assert.deepEqual(agent.files, [{
    source: "worker.md",
    target: "agents/worker.md",
    mode: 0o644,
  }]);
  const reference = result.packages.find(
    (item) => item.descriptor.packageId === referenceDescriptor.packageId,
  );
  assert.ok(reference);
  assert.deepEqual(reference.files, [{
    source: "guide.md",
    target: "reference/guide.md",
    mode: 0o644,
  }]);

  const adapter = result.packages.find((item) => item.descriptor.packageId === adapterDescriptor.packageId);
  assert.ok(adapter);
  assert.deepEqual(adapter.files.map((file) => file.source), [
    "deploy/config.yml",
    "package.json",
    "packages/server/src/server.ts",
  ]);
  assert.ok(adapter.files.every((file) => file.target === `adapters/cp1/${file.source}`));
  assert.ok(adapter.files.every((file) => !file.source.split("/").includes("dist")));

  const taxonomy = result.packages.find(
    (item) => item.descriptor.packageId === taxonomyDescriptor.packageId,
  );
  assert.ok(taxonomy);
  assert.deepEqual(taxonomy.files, [{
    source: "cipherpol.json",
    target: "reference/cipherpol.json",
    mode: 0o644,
  }]);
  assert.equal(
    await readFile(join(taxonomy.artifactRoot, "cipherpol.json"), "utf8"),
    await readFile(join(fixtureRoot, "cipherpol.json"), "utf8"),
  );

  for (const materializedPackage of result.packages) {
    const persisted = persistedPackageView(materializedPackage);
    assert.ok(!isAbsolute(materializedPackage.artifactPath));
    assert.ok(materializedPackage.descriptor.sourcePaths.every((sourcePath) => !isAbsolute(sourcePath)));
    assert.ok(materializedPackage.files.every((file) => !isAbsolute(file.source) && !isAbsolute(file.target)));
    assert.ok(!JSON.stringify(persisted).includes(fixtureRoot));
    assert.ok(!JSON.stringify(persisted).includes(outputRoot));
  }
});

test("rejects empty descriptors, target escapes, duplicate package IDs, and duplicate outputs", async (t) => {
  await assert.rejects(
    materializeClosure({
      sourceRoot: fixtureRoot,
      outputRoot: await outputDirectory(t, "cipherpol-materialize-empty-import-"),
      imported: importedWith([]),
    }),
    (error) => assertAdmissionCode(error, "PROVENANCE_MISMATCH"),
  );

  await assert.rejects(
    materializeClosure({
      sourceRoot: fixtureRoot,
      outputRoot: await outputDirectory(t, "cipherpol-materialize-empty-descriptor-"),
      imported: importedWith([{ ...skillDescriptor, sourcePaths: [] }]),
    }),
    (error) => assertAdmissionCode(error, "PROVENANCE_MISMATCH"),
  );

  await assert.rejects(
    materializeClosure({
      sourceRoot: fixtureRoot,
      outputRoot: await outputDirectory(t, "cipherpol-materialize-target-escape-"),
      imported: importedWith([{ ...agentDescriptor, targetRoot: "../escape.md" }]),
    }),
    (error) => assertAdmissionCode(error, "PROVENANCE_MISMATCH"),
  );

  await assert.rejects(
    materializeClosure({
      sourceRoot: fixtureRoot,
      outputRoot: await outputDirectory(t, "cipherpol-materialize-duplicate-id-"),
      imported: importedWith([agentDescriptor, agentDescriptor]),
    }),
    (error) => assertAdmissionCode(error, "DUPLICATE_PACKAGE_ID"),
  );

  await assert.rejects(
    materializeClosure({
      sourceRoot: fixtureRoot,
      outputRoot: await outputDirectory(t, "cipherpol-materialize-duplicate-output-"),
      imported: importedWith([{
        ...adapterDescriptor,
        sourcePaths: ["cipherpol-1/deploy", "cipherpol-1/deploy/config.yml"],
      }]),
    }),
    (error) => assertAdmissionCode(error, "TARGET_COLLISION"),
  );

  await assert.rejects(
    materializeClosure({
      sourceRoot: fixtureRoot,
      outputRoot: await outputDirectory(t, "cipherpol-materialize-gate-collision-"),
      imported: importedWith([
        agentDescriptor,
        {
          ...referenceDescriptor,
          packageId: "cipherpol.aegis/agent/worker-copy",
          packageKind: "agent",
          targetRoot: "agents/worker.md",
        },
      ]),
    }),
    (error) => assertAdmissionCode(error, "TARGET_COLLISION"),
  );
});

test("rejects descriptor source escapes and symbolic links", async (t) => {
  await assert.rejects(
    materializeClosure({
      sourceRoot: fixtureRoot,
      outputRoot: await outputDirectory(t, "cipherpol-materialize-source-escape-"),
      imported: importedWith([{
        ...agentDescriptor,
        sourcePaths: ["../worker.md"],
      }]),
    }),
    (error) => assertAdmissionCode(error, "PROVENANCE_MISMATCH"),
  );

  const root = await mutableFixture(t);
  const selected = join(root, "cipherpol-aegis/agents/worker.md");
  await unlink(selected);
  await symlink(join(root, "cipherpol-aegis/reference/guide.md"), selected, "file");
  await assert.rejects(
    materializeClosure({
      sourceRoot: root,
      outputRoot: await outputDirectory(t, "cipherpol-materialize-symlink-"),
      imported: importedWith([agentDescriptor]),
    }),
    (error) => assertAdmissionCode(error, "PROVENANCE_MISMATCH"),
  );
});

test("rejects special files inside selected directories", async (t) => {
  // AF_UNIX socket paths are limited to ~104 bytes on macOS; os.tmpdir() (under
  // /var/folders/...) is too long once the fixture subpath is appended, so this
  // test roots the mutable fixture directly under /tmp instead.
  const root = await mutableFixture(t, "/tmp");
  const socketPath = join(root, "cipherpol-aegis/skills/demo/runtime.sock");
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, resolveListen);
  });
  t.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));

  await assert.rejects(
    materializeClosure({
      sourceRoot: root,
      outputRoot: await outputDirectory(t, "cipherpol-materialize-special-"),
      imported: importedWith([skillDescriptor]),
    }),
    (error) => assertAdmissionCode(error, "PROVENANCE_MISMATCH"),
  );
});

test("rejects a selected source replaced during its single secure read", async (t) => {
  const root = await mutableFixture(t);
  const selected = join(root, "cipherpol-aegis/agents/worker.md");
  const probe = await open(selected, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probe) as {
    readFile(): Promise<Buffer>;
  };
  const originalReadFile = fileHandlePrototype.readFile;
  await probe.close();
  let replaced = false;
  fileHandlePrototype.readFile = async function readFileAndReplace(): Promise<Buffer> {
    const content = await originalReadFile.call(this);
    if (!replaced) {
      replaced = true;
      await unlink(selected);
      await writeFile(selected, content);
    }
    return content;
  };

  try {
    await assert.rejects(
      materializeClosure({
        sourceRoot: root,
        outputRoot: await outputDirectory(t, "cipherpol-materialize-replacement-"),
        imported: importedWith([agentDescriptor]),
      }),
      (error) => assertAdmissionCode(error, "PROVENANCE_MISMATCH"),
    );
  } finally {
    fileHandlePrototype.readFile = originalReadFile;
  }
});

const realSourceRoot = process.env.SOFTWARE_DEV_AGENTIC_ROOT;
test("real authored source materializes the complete 152-package closure without dist", {
  skip: realSourceRoot === undefined ? "SOFTWARE_DEV_AGENTIC_ROOT is not set" : false,
}, async (t) => {
  assert.ok(realSourceRoot);
  const imported = await importSoftwareDevAgenticArtifacts({
    repositoryRoot: realSourceRoot,
    sourceRevision: "a8afa8dd0848833b72ef536e1258d5c27bb8e3fc",
  });
  const outputRoot = await outputDirectory(t, "cipherpol-materialize-real-");
  const materialized = await materializeClosure({
    sourceRoot: realSourceRoot,
    outputRoot,
    imported,
  });

  assert.equal(materialized.packages.length, 152);
  const importedParityIds = imported.entries.map((entry) => entry.id).sort();
  const mappedParityIds = imported.artifacts.flatMap((artifact) => artifact.parityIds).sort();
  assert.deepEqual(mappedParityIds, importedParityIds);
  assert.ok(imported.artifacts.every((artifact) => artifact.sourcePaths.length > 0));
  assert.ok(imported.artifacts.every((artifact) => artifact.sourcePaths.every(
    (sourcePath) => !sourcePath.split("/").includes("dist"),
  )));
  assert.ok(materialized.packages.every((item) => item.files.length > 0));
  assert.ok(materialized.packages.every((item) => item.files.every(
    (file) => !file.source.split("/").includes("dist"),
  )));
});
