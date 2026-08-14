import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { CipherpolAdmissionError } from "../src/errors.js";
import { importSoftwareDevAgenticArtifacts } from "../src/importer.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures/software-dev-agentic", import.meta.url));
const revision = "0123456789abcdef";
async function mutableFixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cipherpol-importer-"));
  await cp(fixtureRoot, root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function assertAdmissionCode(error: unknown, code: CipherpolAdmissionError["code"]): boolean {
  assert.ok(error instanceof CipherpolAdmissionError);
  assert.equal(error.code, code);
  return true;
}

test("imports configured authored sources deterministically with provenance-rich semantics", async () => {
  const first = await importSoftwareDevAgenticArtifacts({ repositoryRoot: fixtureRoot, sourceRevision: revision });
  const second = await importSoftwareDevAgenticArtifacts({ repositoryRoot: fixtureRoot, sourceRevision: revision });
  assert.deepEqual(second, first);
  assert.equal(first.entries.filter((entry) => entry.artifactType === "mcp-tool").length, 17);
  assert.equal(first.entries.filter((entry) => entry.artifactType === "taxonomy").length, 1);

  const command = first.entries.find((entry) => entry.name === "demo-command");
  assert.ok(command);
  assert.equal(command.id, "cipherpol.aegis/orchestrator/demo-command");
  assert.equal(command.moduleVersion, "16.0.1");
  assert.equal(command.sourceRevision, revision);
  assert.deepEqual(command.composition, ["cipherpol.aegis/internal-procedure/demo-procedure"]);
  assert.deepEqual(command.dependencies, ["cipherpol.aegis/reference/demo/guide"]);
  assert.deepEqual(command.toolCapabilities, ["Bash", "Read"]);
  assert.ok(command.evidence.every((item) => item.length > 0));

  const worker = first.entries.find((entry) => entry.name === "demo-worker");
  assert.ok(worker);
  assert.deepEqual(worker.dependencies, [
    "cipherpol.aegis/internal-procedure/demo-procedure",
    "cipherpol.aegis/reference/demo/guide",
  ]);
  assert.deepEqual(worker.mcpCapabilities, ["mcp__plugin_cipherpol-1_cp1__search_docs"]);
  assert.equal("packages" in first, false);
  assert.equal(first.artifacts.length, 7);
  assert.equal(first.artifacts.filter((artifact) => artifact.packageKind === "skill").length, 2);
  assert.equal(first.artifacts.filter((artifact) => artifact.packageKind === "procedure").length, 1);
  assert.equal(first.artifacts.filter((artifact) => artifact.packageKind === "agent").length, 1);
  assert.equal(first.artifacts.filter((artifact) => artifact.packageKind === "reference").length, 2);
  const commandDescriptor = first.artifacts.find((artifact) => artifact.packageId === command.id);
  assert.ok(commandDescriptor);
  assert.equal(commandDescriptor.sourceKind, "directory");
  assert.deepEqual(commandDescriptor.sourcePaths, [
    "cipherpol-aegis/lib/demo/skills/orchestrators/demo-command",
  ]);
  assert.equal(commandDescriptor.targetRoot, "skills/demo-command");

  const adapter = first.artifacts.find((artifact) => artifact.packageKind === "adapter");
  assert.ok(adapter);
  assert.equal(adapter.packageId, "cipherpol.1/adapter/cp1");
  assert.equal(adapter.sourceKind, "cp1-adapter");
  assert.equal(adapter.parityIds.length, 17);
  assert.ok(adapter.sourcePaths.includes("cipherpol-1/packages/mcp-server/src"));
  assert.ok(adapter.sourcePaths.every((sourcePath) => !sourcePath.split("/").includes("dist")));

  const mappedParityIds = first.artifacts.flatMap((artifact) => artifact.parityIds);
  assert.equal(new Set(mappedParityIds).size, first.entries.length);
  assert.deepEqual([...mappedParityIds].sort(), first.entries.map((entry) => entry.id).sort());
});

test("rejects a mismatched module VERSION", async (t) => {
  const root = await mutableFixture(t);
  await writeFile(join(root, "cipherpol-9/VERSION"), "13.13.0\n");
  await assert.rejects(
    importSoftwareDevAgenticArtifacts({ repositoryRoot: root, sourceRevision: revision }),
    (error) => assertAdmissionCode(error, "PROVENANCE_MISMATCH"),
  );
});

test("rejects missing build configuration", async (t) => {
  const root = await mutableFixture(t);
  await unlink(join(root, "cipherpol-9/plugin/build.config.json"));
  await assert.rejects(
    importSoftwareDevAgenticArtifacts({ repositoryRoot: root, sourceRevision: revision }),
    (error) => assertAdmissionCode(error, "PROVENANCE_MISMATCH"),
  );
});

test("rejects malformed YAML frontmatter", async (t) => {
  const root = await mutableFixture(t);
  const path = join(root, "cipherpol-aegis/lib/demo/agents/demo-worker.md");
  await writeFile(path, "---\nname: demo-worker\nname: duplicate\ndescription: invalid\n---\n");
  await assert.rejects(
    importSoftwareDevAgenticArtifacts({ repositoryRoot: root, sourceRevision: revision }),
    (error) => assertAdmissionCode(error, "PROVENANCE_MISMATCH"),
  );
});

test("rejects deterministic flattened basename collisions", async (t) => {
  const root = await mutableFixture(t);
  const original = join(root, "cipherpol-aegis/lib/demo/agents/demo-worker.md");
  const collision = join(root, "cipherpol-aegis/lib/other/agents/demo-worker.md");
  await mkdir(dirname(collision), { recursive: true });
  await cp(original, collision, { recursive: false });
  await assert.rejects(
    importSoftwareDevAgenticArtifacts({ repositoryRoot: root, sourceRevision: revision }),
    (error) => assertAdmissionCode(error, "DUPLICATE_PACKAGE_ID"),
  );
});

test("rejects cp1 registration count or source-shape drift", async (t) => {
  const root = await mutableFixture(t);
  const path = join(root, "cipherpol-1/packages/mcp-server/src/create-server.ts");
  const source = await readFile(path, "utf8");
  await writeFile(path, source.replace(/^.*delete_memory.*\n/m, ""));
  await assert.rejects(
    importSoftwareDevAgenticArtifacts({ repositoryRoot: root, sourceRevision: revision }),
    (error) => assertAdmissionCode(error, "PROVENANCE_MISMATCH"),
  );
});

test("rejects a symlinked configured include directory", async (t) => {
  const root = await mutableFixture(t);
  const includeDirectory = join(root, "cipherpol-aegis/lib/demo/agents");
  const outsideDirectory = await temporaryDirectory(t, "cipherpol-importer-outside-agents-");
  await cp(includeDirectory, outsideDirectory, { recursive: true });
  await rm(includeDirectory, { recursive: true });
  await symlink(outsideDirectory, includeDirectory, "dir");

  await assert.rejects(
    importSoftwareDevAgenticArtifacts({ repositoryRoot: root, sourceRevision: revision }),
    (error) => assertAdmissionCode(error, "PROVENANCE_MISMATCH"),
  );
});

test("rejects a symlinked selected skill directory", async (t) => {
  const root = await mutableFixture(t);
  const skillDirectory = join(root, "cipherpol-aegis/lib/demo/skills/orchestrators/demo-command");
  const outsideDirectory = await temporaryDirectory(t, "cipherpol-importer-outside-skill-");
  await cp(skillDirectory, outsideDirectory, { recursive: true });
  await rm(skillDirectory, { recursive: true });
  await symlink(outsideDirectory, skillDirectory, "dir");

  await assert.rejects(
    importSoftwareDevAgenticArtifacts({ repositoryRoot: root, sourceRevision: revision }),
    (error) => assertAdmissionCode(error, "PROVENANCE_MISMATCH"),
  );
});

test("rejects a symlinked selected regular source file", async (t) => {
  const root = await mutableFixture(t);
  const sourceFile = join(root, "cipherpol-aegis/lib/demo/agents/demo-worker.md");
  const outsideDirectory = await temporaryDirectory(t, "cipherpol-importer-outside-file-");
  const outsideFile = join(outsideDirectory, "demo-worker.md");
  await cp(sourceFile, outsideFile);
  await unlink(sourceFile);
  await symlink(outsideFile, sourceFile, "file");

  await assert.rejects(
    importSoftwareDevAgenticArtifacts({ repositoryRoot: root, sourceRevision: revision }),
    (error) => assertAdmissionCode(error, "PROVENANCE_MISMATCH"),
  );
});

test("rejects a symlinked repository root", async (t) => {
  const root = await mutableFixture(t);
  const aliasDirectory = await temporaryDirectory(t, "cipherpol-importer-root-alias-");
  const repositoryAlias = join(aliasDirectory, "software-dev-agentic");
  await symlink(root, repositoryAlias, "dir");

  await assert.rejects(
    importSoftwareDevAgenticArtifacts({ repositoryRoot: repositoryAlias, sourceRevision: revision }),
    (error) => assertAdmissionCode(error, "PROVENANCE_MISMATCH"),
  );
});

const realSourceRoot = process.env.SOFTWARE_DEV_AGENTIC_ROOT;
test("real authored source measures the complete physical closure", {
  skip: realSourceRoot === undefined ? "SOFTWARE_DEV_AGENTIC_ROOT is not set" : false,
}, async () => {
  assert.ok(realSourceRoot);
  const imported = await importSoftwareDevAgenticArtifacts({
    repositoryRoot: realSourceRoot,
    sourceRevision: "a8afa8dd0848833b72ef536e1258d5c27bb8e3fc",
  });

  assert.equal(imported.artifacts.length, 152);
  assert.equal(
    imported.artifacts.filter((artifact) => artifact.packageKind === "skill"
      || artifact.packageKind === "procedure").length,
    67,
  );
  assert.equal(imported.artifacts.filter((artifact) => artifact.packageKind === "agent").length, 47);
  assert.equal(
    imported.artifacts.filter((artifact) => artifact.packageKind === "reference"
      && artifact.sourcePaths[0]?.endsWith(".md")).length,
    36,
  );
  assert.equal(
    imported.artifacts.filter((artifact) => artifact.targetRoot === "reference/cipherpol.json").length,
    1,
  );

  const adapters = imported.artifacts.filter((artifact) => artifact.packageKind === "adapter");
  assert.equal(adapters.length, 1);
  assert.equal(adapters[0]?.parityIds.length, 17);
  assert.ok(adapters[0]?.sourcePaths.includes("cipherpol-1/plugin/build.sh") === false);
  assert.ok(adapters[0]?.sourcePaths.includes("cipherpol-1/packages/mcp-server/src"));
  assert.ok(adapters[0]?.sourcePaths.includes("cipherpol-1/deploy/supabase-min/volumes"));
  assert.ok(adapters[0]?.sourcePaths.includes("cipherpol-1/supabase/migrations"));

  const packageIds = imported.artifacts.map((artifact) => artifact.packageId);
  const mappedParityIds = imported.artifacts.flatMap((artifact) => artifact.parityIds);
  assert.equal(new Set(packageIds).size, 152);
  assert.equal(mappedParityIds.length, 168);
  assert.equal(new Set(mappedParityIds).size, 168);
  assert.deepEqual([...mappedParityIds].sort(), imported.entries.map((entry) => entry.id).sort());
  for (const artifact of imported.artifacts) {
    assert.equal(artifact.moduleVersion, imported.moduleVersions[artifact.module]);
    assert.ok(artifact.sourcePaths.length > 0);
    assert.ok(artifact.sourcePaths.every((sourcePath) => !sourcePath.split("/").includes("dist")));
  }
});
