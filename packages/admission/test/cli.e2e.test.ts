import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { packageRecordSchema } from "@cipherpol/contracts";
import { importSoftwareDevAgenticArtifacts } from "../src/importer.js";
import { compareClosureTrees } from "../src/reproducibility.js";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const fixtureRoot = fileURLToPath(new URL("./fixtures/software-dev-agentic", import.meta.url));
const checkedInPolicyPath = fileURLToPath(
  new URL("../../../fixtures/software-dev-agentic/import-policy.yaml", import.meta.url),
);
const fixturePrivateKeyPath = fileURLToPath(
  new URL("../../../fixtures/software-dev-agentic/stage2-fixture-private.pem", import.meta.url),
);
const fixturePublicKeyPath = fileURLToPath(
  new URL("../../../fixtures/software-dev-agentic/stage2-fixture-public.pem", import.meta.url),
);
const APPROVED_FIXTURE_KEY_ID = "fixture.stage2.software-dev-agentic";
const sourceRevision = "0123456789abcdef";

interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(args: readonly string[]): Promise<CliResult> {
  return await new Promise<CliResult>((resolveCommand, rejectCommand) => {
    const child = spawn(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: dirname(cliPath),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", rejectCommand);
    child.on("close", (status, signal) => {
      if (status === null) {
        rejectCommand(new Error(`CLI terminated by signal ${signal ?? "unknown"}`));
        return;
      }
      resolveCommand({ status, stdout, stderr });
    });
  });
}

async function createTemporaryRoot(context: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cipherpol-admission-cli-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function snapshotFiles(paths: readonly string[]): Promise<Record<string, { contents: string; mtimeMs: number }>> {
  const snapshots: Record<string, { contents: string; mtimeMs: number }> = {};
  await Promise.all(paths.map(async (path) => {
    const [contents, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    snapshots[path] = { contents, mtimeMs: metadata.mtimeMs };
  }));
  return snapshots;
}

async function listFilesRecursively(root: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(currentDirectory: string): Promise<void> {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      results.push(entryPath);
    }
  }
  await walk(root);
  return results.sort();
}

async function copyTreePreservingModes(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyTreePreservingModes(sourcePath, destinationPath);
      continue;
    }
    const sourceStats = await stat(sourcePath);
    await copyFile(sourcePath, destinationPath);
    await chmod(destinationPath, sourceStats.mode & 0o777);
  }
}

async function writeEd25519KeyPair(directory: string, name: string): Promise<{ privateKeyPath: string; publicKeyPath: string }> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = join(directory, `${name}-private.pem`);
  const publicKeyPath = join(directory, `${name}-public.pem`);
  await Promise.all([
    writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { encoding: "utf8", mode: 0o600 }),
    writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }).toString(), "utf8"),
  ]);
  return { privateKeyPath, publicKeyPath };
}

test("import rejects an incomplete parity baseline without writing output", async (context) => {
  const root = await createTemporaryRoot(context);
  const output = join(root, "parity.yaml");
  const args = [
    "import",
    "--source-root", fixtureRoot,
    "--source-revision", sourceRevision,
    "--output", output,
  ];
  const result = await runCli(args);

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "PARITY_BASELINE_VIOLATION: Parity manifest does not satisfy cipherpol.parity/v2\n",
  );
  await assert.rejects(stat(output), { code: "ENOENT" });
  await writeFile(output, "existing manifest\n", "utf8");
  const forced = await runCli([...args, "--force"]);
  assert.equal(forced.status, 2);
  assert.equal(await readFile(output, "utf8"), "existing manifest\n");
});

test("admits and verifies an artifact without disclosing or mutating key material", async (context) => {
  const root = await createTemporaryRoot(context);
  const artifactRoot = join(root, "artifact");
  const artifactFile = join(artifactRoot, "agent.md");
  const metadataPath = join(root, "metadata.json");
  const privateKeyPath = join(root, "private.pem");
  const publicKeyPath = join(root, "public.pem");
  const envelopePath = join(root, "admission.json");
  const packageSetPath = join(root, "package-set.json");
  const skillsDirectory = join(root, "skills");
  const agentsDirectory = join(root, "agents");
  await Promise.all([
    mkdir(artifactRoot, { recursive: true }),
    mkdir(join(skillsDirectory, "safe-skill"), { recursive: true }),
    mkdir(agentsDirectory, { recursive: true }),
  ]);
  await writeFile(artifactFile, "# Router\n", "utf8");
  await Promise.all([
    writeFile(join(skillsDirectory, "safe-skill", "SKILL.md"), "# Safe skill\n", "utf8"),
    writeFile(join(agentsDirectory, "safe-agent.md"), "# Safe agent\n", "utf8"),
    writeFile(join(agentsDirectory, "router.md"), await readFile(artifactFile)),
    writeJson(packageSetPath, {
      packages: [{ id: "acme/agents/router", dependencies: [] }],
    }),
  ]);

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  await Promise.all([
    writeFile(privateKeyPath, privateKeyPem, { encoding: "utf8", mode: 0o600 }),
    writeFile(publicKeyPath, publicKeyPem, "utf8"),
    writeJson(metadataPath, {
      id: "acme/agents/router",
      kind: "agent",
      version: "1.0.0",
      owner: "platform-security",
      sourceRevision: "abc1234",
      artifactPath: "packages/acme/agents/router",
      compatibility: { claudeCode: ">=1.0.0", capabilities: [] },
      dependencies: [],
      files: [{ source: "agent.md", target: "agents/router.md" }],
      provenance: {
        sourceRepository: "https://example.test/acme/agents.git",
        sourceRevision: "abc1234",
        sourcePaths: ["agent.md"],
      },
    }),
  ]);

  const admitted = await runCli([
    "admit",
    "--metadata", metadataPath,
    "--artifact-root", artifactRoot,
    "--private-key", privateKeyPath,
    "--package-set", packageSetPath,
    "--skills-directory", skillsDirectory,
    "--agents-directory", agentsDirectory,
    "--key-id", "release-key-1",
    "--output", envelopePath,
  ]);
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(admitted.stderr, "");
  assert.doesNotMatch(admitted.stdout, /BEGIN PRIVATE KEY|PRIVATE KEY/);
  assert.equal(admitted.stdout.includes(privateKeyPem), false);

  const parsedEnvelope: unknown = JSON.parse(await readFile(envelopePath, "utf8"));
  assert.ok(parsedEnvelope !== null && typeof parsedEnvelope === "object");
  assert.ok("schemaVersion" in parsedEnvelope);
  assert.equal(parsedEnvelope.schemaVersion, "cipherpol.admission/v1");
  assert.ok("packageRecord" in parsedEnvelope);
  const packageRecord = packageRecordSchema.parse(parsedEnvelope.packageRecord);
  assert.ok("keyId" in parsedEnvelope);
  assert.equal(parsedEnvelope.keyId, "release-key-1");
  assert.equal(admitted.stdout, `${[
    "admitted",
    `id=${packageRecord.id}`,
    `digest=${packageRecord.digest}`,
    "keyId=release-key-1",
    `output=${resolve(envelopePath)}`,
  ].join(" ")}\n`);

  const protectedPaths = [artifactFile, envelopePath, publicKeyPath];
  const beforeVerification = await snapshotFiles(protectedPaths);
  const verified = await runCli([
    "verify",
    "--envelope", envelopePath,
    "--public-key", publicKeyPath,
    "--key-id", "release-key-1",
    "--artifact-root", artifactRoot,
  ]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.stderr, "");
  assert.equal(verified.stdout, `${[
    "verified",
    `id=${packageRecord.id}`,
    `digest=${packageRecord.digest}`,
    "keyId=release-key-1",
  ].join(" ")}\n`);
  assert.deepEqual(await snapshotFiles(protectedPaths), beforeVerification);

  const missingTrustedIdentity = await runCli([
    "verify",
    "--envelope", envelopePath,
    "--public-key", publicKeyPath,
  ]);
  assert.equal(missingTrustedIdentity.status, 2);
  assert.equal(missingTrustedIdentity.stderr, "USAGE: --key-id is required\n");

  const independentlyRejectedIdentity = await runCli([
    "verify",
    "--envelope", envelopePath,
    "--public-key", publicKeyPath,
    "--key-id", "different-release-key",
  ]);
  assert.equal(independentlyRejectedIdentity.status, 2);
  assert.equal(
    independentlyRejectedIdentity.stderr,
    "UNTRUSTED_KEY: Admission key ID is not trusted\n",
  );

  await writeFile(artifactFile, "# Tampered Router\n", "utf8");
  const tampered = await runCli([
    "verify",
    "--envelope", envelopePath,
    "--public-key", publicKeyPath,
    "--key-id", "release-key-1",
    "--artifact-root", artifactRoot,
  ]);
  assert.equal(tampered.status, 2);
  assert.equal(tampered.stdout, "");
  assert.equal(tampered.stderr, "DIGEST_MISMATCH: Artifact digest does not match admitted package\n");

  const invalidKeySentinel = "PRIVATE_KEY_SENTINEL_DO_NOT_PRINT";
  const invalidPrivateKeyPath = join(root, "invalid-private.pem");
  await writeFile(invalidPrivateKeyPath, invalidKeySentinel, "utf8");
  const invalidKey = await runCli([
    "admit",
    "--metadata", metadataPath,
    "--artifact-root", artifactRoot,
    "--package-set", packageSetPath,
    "--skills-directory", skillsDirectory,
    "--agents-directory", agentsDirectory,
    "--private-key", invalidPrivateKeyPath,
    "--key-id", "release-key-1",
    "--output", join(root, "invalid-key-admission.json"),
  ]);
  assert.equal(invalidKey.status, 2);
  assert.equal(invalidKey.stdout, "");
  assert.equal(invalidKey.stderr, "INVALID_PRIVATE_KEY: Private key file must contain a valid PEM private key\n");
  assert.equal(invalidKey.stderr.includes(invalidKeySentinel), false);
});

test("admit and verify enforce the approved fixture key identity", async (context) => {
  const root = await createTemporaryRoot(context);
  const artifactRoot = join(root, "artifact");
  const artifactFile = join(artifactRoot, "agent.md");
  const metadataPath = join(root, "metadata.json");
  const packageSetPath = join(root, "package-set.json");
  const skillsDirectory = join(root, "skills");
  const agentsDirectory = join(root, "agents");
  const fixtureEnvelopePath = join(root, "fixture-admission.json");
  const productionEnvelopePath = join(root, "production-admission.json");
  const { privateKeyPath: strangerPrivateKeyPath, publicKeyPath: strangerPublicKeyPath } = await writeEd25519KeyPair(
    root,
    "stranger",
  );

  await Promise.all([
    mkdir(artifactRoot, { recursive: true }),
    mkdir(join(skillsDirectory, "safe-skill"), { recursive: true }),
    mkdir(agentsDirectory, { recursive: true }),
  ]);
  await writeFile(artifactFile, "# Router\n", "utf8");
  await Promise.all([
    writeFile(join(skillsDirectory, "safe-skill", "SKILL.md"), "# Safe skill\n", "utf8"),
    writeFile(join(agentsDirectory, "safe-agent.md"), "# Safe agent\n", "utf8"),
    writeFile(join(agentsDirectory, "router.md"), await readFile(artifactFile)),
    writeJson(packageSetPath, {
      packages: [{ id: "acme/agents/router", dependencies: [] }],
    }),
    writeJson(metadataPath, {
      id: "acme/agents/router",
      kind: "agent",
      version: "1.0.0",
      owner: "platform-security",
      sourceRevision: "abc1234",
      artifactPath: "packages/acme/agents/router",
      compatibility: { claudeCode: ">=1.0.0", capabilities: [] },
      dependencies: [],
      files: [{ source: "agent.md", target: "agents/router.md" }],
      provenance: {
        sourceRepository: "https://example.test/acme/agents.git",
        sourceRevision: "abc1234",
        sourcePaths: ["agent.md"],
      },
    }),
  ]);

  const admitArgs = [
    "--metadata", metadataPath,
    "--artifact-root", artifactRoot,
    "--package-set", packageSetPath,
    "--skills-directory", skillsDirectory,
    "--agents-directory", agentsDirectory,
  ];

  const wrongKeyWithFixtureFlag = await runCli([
    "admit",
    ...admitArgs,
    "--private-key", strangerPrivateKeyPath,
    "--key-id", "not-the-fixture-key",
    "--output", fixtureEnvelopePath,
    "--fixture",
  ]);
  assert.equal(wrongKeyWithFixtureFlag.status, 2);
  assert.equal(
    wrongKeyWithFixtureFlag.stderr,
    "UNTRUSTED_KEY: The --fixture flag requires the approved fixture key ID\n",
  );
  await assert.rejects(stat(fixtureEnvelopePath), { code: "ENOENT" });

  const fixtureIdWithoutFlag = await runCli([
    "admit",
    ...admitArgs,
    "--private-key", fixturePrivateKeyPath,
    "--key-id", APPROVED_FIXTURE_KEY_ID,
    "--output", fixtureEnvelopePath,
  ]);
  assert.equal(fixtureIdWithoutFlag.status, 2);
  assert.equal(
    fixtureIdWithoutFlag.stderr,
    "UNTRUSTED_KEY: The approved fixture key ID requires the --fixture flag\n",
  );
  await assert.rejects(stat(fixtureEnvelopePath), { code: "ENOENT" });

  const admittedWithFixtureKey = await runCli([
    "admit",
    ...admitArgs,
    "--private-key", fixturePrivateKeyPath,
    "--key-id", APPROVED_FIXTURE_KEY_ID,
    "--output", fixtureEnvelopePath,
    "--fixture",
  ]);
  assert.equal(admittedWithFixtureKey.status, 0, admittedWithFixtureKey.stderr);
  const fixtureEnvelope: unknown = JSON.parse(await readFile(fixtureEnvelopePath, "utf8"));
  assert.ok(fixtureEnvelope !== null && typeof fixtureEnvelope === "object");
  assert.ok("keyPurpose" in fixtureEnvelope);
  assert.equal(fixtureEnvelope.keyPurpose, "fixture");

  const admittedWithProductionKey = await runCli([
    "admit",
    ...admitArgs,
    "--private-key", strangerPrivateKeyPath,
    "--key-id", "not-the-fixture-key",
    "--output", productionEnvelopePath,
  ]);
  assert.equal(admittedWithProductionKey.status, 0, admittedWithProductionKey.stderr);
  const productionEnvelope: unknown = JSON.parse(await readFile(productionEnvelopePath, "utf8"));
  assert.ok(productionEnvelope !== null && typeof productionEnvelope === "object");
  assert.ok("keyPurpose" in productionEnvelope);
  assert.equal(productionEnvelope.keyPurpose, "production");

  const verifyFixtureWithoutFlag = await runCli([
    "verify",
    "--envelope", fixtureEnvelopePath,
    "--public-key", fixturePublicKeyPath,
    "--key-id", APPROVED_FIXTURE_KEY_ID,
  ]);
  assert.equal(verifyFixtureWithoutFlag.status, 2);
  assert.equal(
    verifyFixtureWithoutFlag.stderr,
    "UNTRUSTED_KEY: The approved fixture key ID requires the --fixture flag\n",
  );

  const verifyProductionWithFixtureFlag = await runCli([
    "verify",
    "--envelope", productionEnvelopePath,
    "--public-key", strangerPublicKeyPath,
    "--key-id", "not-the-fixture-key",
    "--fixture",
  ]);
  assert.equal(verifyProductionWithFixtureFlag.status, 2);
  assert.equal(
    verifyProductionWithFixtureFlag.stderr,
    "UNTRUSTED_KEY: The --fixture flag requires the approved fixture key ID\n",
  );

  const verifyFixtureWithFlag = await runCli([
    "verify",
    "--envelope", fixtureEnvelopePath,
    "--public-key", fixturePublicKeyPath,
    "--key-id", APPROVED_FIXTURE_KEY_ID,
    "--fixture",
  ]);
  assert.equal(verifyFixtureWithFlag.status, 0, verifyFixtureWithFlag.stderr);

  const verifyProductionWithoutFlag = await runCli([
    "verify",
    "--envelope", productionEnvelopePath,
    "--public-key", strangerPublicKeyPath,
    "--key-id", "not-the-fixture-key",
  ]);
  assert.equal(verifyProductionWithoutFlag.status, 0, verifyProductionWithoutFlag.stderr);
});

test("close builds a reproducible closure and verify-closure confirms package and mapping counts", async (context) => {
  const root = await createTemporaryRoot(context);
  const { privateKeyPath, publicKeyPath } = await writeEd25519KeyPair(root, "closure");

  const expected = await importSoftwareDevAgenticArtifacts({ repositoryRoot: fixtureRoot, sourceRevision });
  const expectedMcpMappings = expected.entries.filter((entry) => entry.artifactType === "mcp-tool").length;

  const outputA = join(root, "registry-a");
  const closed = await runCli([
    "close",
    "--source-root", fixtureRoot,
    "--source-revision", sourceRevision,
    "--policy", checkedInPolicyPath,
    "--private-key", privateKeyPath,
    "--key-id", "closure-test-key",
    "--output", outputA,
  ]);
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(closed.stderr, "");
  assert.equal(closed.stdout, [
    `physical packages ${expected.artifacts.length}`,
    `parity mappings ${expected.entries.length}`,
    `cp1 MCP mappings ${expectedMcpMappings}`,
    "clean-room comparison identical",
    "registry signature verified",
    "",
  ].join("\n"));
  assert.doesNotMatch(closed.stdout, /PRIVATE KEY/);

  await stat(join(outputA, "registry-envelope.json"));
  const admissionFiles = await listFilesRecursively(join(outputA, "admissions"));
  assert.ok(admissionFiles.length > 0);
  const artifactFiles = await listFilesRecursively(join(outputA, "artifacts"));
  assert.ok(artifactFiles.length > 0);

  const leftoverStagingEntries = (await readdir(root)).filter((name) => name.includes("stage2-closure"));
  assert.deepEqual(leftoverStagingEntries, []);

  const outputB = join(root, "registry-b");
  const closedAgain = await runCli([
    "close",
    "--source-root", fixtureRoot,
    "--source-revision", sourceRevision,
    "--policy", checkedInPolicyPath,
    "--private-key", privateKeyPath,
    "--key-id", "closure-test-key",
    "--output", outputB,
  ]);
  assert.equal(closedAgain.status, 0, closedAgain.stderr);
  await assert.doesNotReject(compareClosureTrees(outputA, outputB));

  const verified = await runCli([
    "verify-closure",
    "--registry-root", outputA,
    "--public-key", publicKeyPath,
    "--key-id", "closure-test-key",
    "--verify-artifacts",
  ]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.stdout, [
    `physical packages ${expected.artifacts.length}`,
    `parity mappings ${expected.entries.length}`,
    `cp1 MCP mappings ${expectedMcpMappings}`,
    "registry signature verified",
    "",
  ].join("\n"));
});

test("close refuses to overwrite an existing output directory without --force, and --force replaces it", async (context) => {
  const root = await createTemporaryRoot(context);
  const { privateKeyPath } = await writeEd25519KeyPair(root, "closure");
  const outputPath = join(root, "registry");

  const closeArgs = (revision: string): string[] => [
    "close",
    "--source-root", fixtureRoot,
    "--source-revision", revision,
    "--policy", checkedInPolicyPath,
    "--private-key", privateKeyPath,
    "--key-id", "closure-test-key",
    "--output", outputPath,
  ];

  const first = await runCli(closeArgs(sourceRevision));
  assert.equal(first.status, 0, first.stderr);

  const beforeSnapshot = await snapshotFiles(await listFilesRecursively(outputPath));

  const secondRevision = "fedcba9876543210";
  const rejected = await runCli(closeArgs(secondRevision));
  assert.equal(rejected.status, 2);
  assert.equal(rejected.stdout, "");
  assert.equal(rejected.stderr, "OUTPUT_EXISTS: Output already exists; pass --force to replace it\n");
  assert.deepEqual(await snapshotFiles(await listFilesRecursively(outputPath)), beforeSnapshot);

  const forced = await runCli([...closeArgs(secondRevision), "--force"]);
  assert.equal(forced.status, 0, forced.stderr);

  const registryEnvelopeAfter = JSON.parse(
    await readFile(join(outputPath, "registry-envelope.json"), "utf8"),
  ) as { closureManifest: { sourceRevision: string } };
  assert.equal(registryEnvelopeAfter.closureManifest.sourceRevision, secondRevision);
});

test("close refuses to publish when the import policy is incomplete for the corpus", async (context) => {
  const root = await createTemporaryRoot(context);
  const { privateKeyPath } = await writeEd25519KeyPair(root, "closure");

  const incompletePolicyPath = join(root, "incomplete-import-policy.yaml");
  await writeFile(incompletePolicyPath, [
    "schemaVersion: cipherpol.import-policy/v1",
    "modules:",
    "  cipherpol-aegis:",
    "    owner: mobile-platform",
    "    packageVersion: module-version",
    '    claudeCode: ">=2.1.0 <3.0.0"',
    "    capabilities: [plugins]",
    "  cipherpol-9:",
    "    owner: mobile-platform",
    "    packageVersion: module-version",
    '    claudeCode: ">=2.1.0 <3.0.0"',
    "    capabilities: [plugins]",
    "packageDependencies: {}",
    "",
  ].join("\n"), "utf8");

  const outputPath = join(root, "registry");
  const result = await runCli([
    "close",
    "--source-root", fixtureRoot,
    "--source-revision", sourceRevision,
    "--policy", incompletePolicyPath,
    "--private-key", privateKeyPath,
    "--key-id", "closure-test-key",
    "--output", outputPath,
  ]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "INVALID_ADMISSION: Import policy does not match cipherpol.import-policy/v1\n");
  await assert.rejects(stat(outputPath), { code: "ENOENT" });
});

test("close and verify-closure enforce the approved fixture key identity", async (context) => {
  const root = await createTemporaryRoot(context);
  const outputPath = join(root, "registry");
  const { privateKeyPath: strangerPrivateKeyPath } = await writeEd25519KeyPair(root, "stranger");

  const wrongKeyWithFixtureFlag = await runCli([
    "close",
    "--source-root", fixtureRoot,
    "--source-revision", sourceRevision,
    "--policy", checkedInPolicyPath,
    "--private-key", strangerPrivateKeyPath,
    "--key-id", "not-the-fixture-key",
    "--output", outputPath,
    "--fixture",
  ]);
  assert.equal(wrongKeyWithFixtureFlag.status, 2);
  assert.equal(wrongKeyWithFixtureFlag.stdout, "");
  assert.equal(
    wrongKeyWithFixtureFlag.stderr,
    "UNTRUSTED_KEY: The --fixture flag requires the approved fixture key ID\n",
  );
  await assert.rejects(stat(outputPath), { code: "ENOENT" });

  const fixtureIdWithoutFlag = await runCli([
    "close",
    "--source-root", fixtureRoot,
    "--source-revision", sourceRevision,
    "--policy", checkedInPolicyPath,
    "--private-key", strangerPrivateKeyPath,
    "--key-id", APPROVED_FIXTURE_KEY_ID,
    "--output", outputPath,
  ]);
  assert.equal(fixtureIdWithoutFlag.status, 2);
  assert.equal(
    fixtureIdWithoutFlag.stderr,
    "UNTRUSTED_KEY: The approved fixture key ID requires the --fixture flag\n",
  );
  await assert.rejects(stat(outputPath), { code: "ENOENT" });

  const closedWithFixtureKey = await runCli([
    "close",
    "--source-root", fixtureRoot,
    "--source-revision", sourceRevision,
    "--policy", checkedInPolicyPath,
    "--private-key", fixturePrivateKeyPath,
    "--key-id", APPROVED_FIXTURE_KEY_ID,
    "--output", outputPath,
    "--fixture",
  ]);
  assert.equal(closedWithFixtureKey.status, 0, closedWithFixtureKey.stderr);
  assert.doesNotMatch(closedWithFixtureKey.stdout, /PRIVATE KEY/);

  const verifiedAsProduction = await runCli([
    "verify-closure",
    "--registry-root", outputPath,
    "--public-key", fixturePublicKeyPath,
    "--key-id", APPROVED_FIXTURE_KEY_ID,
  ]);
  assert.equal(verifiedAsProduction.status, 2);
  assert.equal(
    verifiedAsProduction.stderr,
    "UNTRUSTED_KEY: Fixture-purpose registry keys are not trusted unless explicitly allowed\n",
  );

  const verifiedAsFixture = await runCli([
    "verify-closure",
    "--registry-root", outputPath,
    "--public-key", fixturePublicKeyPath,
    "--key-id", APPROVED_FIXTURE_KEY_ID,
    "--fixture",
  ]);
  assert.equal(verifiedAsFixture.status, 0, verifiedAsFixture.stderr);
});

test("verify-closure rejects a mismatched key ID and a wrong public key", async (context) => {
  const root = await createTemporaryRoot(context);
  const { privateKeyPath, publicKeyPath } = await writeEd25519KeyPair(root, "closure");
  const outputPath = join(root, "registry");

  const closed = await runCli([
    "close",
    "--source-root", fixtureRoot,
    "--source-revision", sourceRevision,
    "--policy", checkedInPolicyPath,
    "--private-key", privateKeyPath,
    "--key-id", "right-key",
    "--output", outputPath,
  ]);
  assert.equal(closed.status, 0, closed.stderr);

  const wrongKeyId = await runCli([
    "verify-closure",
    "--registry-root", outputPath,
    "--public-key", publicKeyPath,
    "--key-id", "wrong-key",
  ]);
  assert.equal(wrongKeyId.status, 2);
  assert.equal(wrongKeyId.stderr, "UNTRUSTED_KEY: Registry key ID is not trusted\n");

  const { publicKeyPath: unrelatedPublicKeyPath } = await writeEd25519KeyPair(root, "unrelated");
  const wrongKey = await runCli([
    "verify-closure",
    "--registry-root", outputPath,
    "--public-key", unrelatedPublicKeyPath,
    "--key-id", "right-key",
  ]);
  assert.equal(wrongKey.status, 2);
  assert.equal(wrongKey.stderr, "SIGNATURE_INVALID: Registry signature is invalid\n");
});

test("verify-closure --verify-artifacts detects byte and mode tampering, and never mutates the registry root", async (context) => {
  const root = await createTemporaryRoot(context);
  const { privateKeyPath, publicKeyPath } = await writeEd25519KeyPair(root, "closure");
  const outputPath = join(root, "registry");

  const closed = await runCli([
    "close",
    "--source-root", fixtureRoot,
    "--source-revision", sourceRevision,
    "--policy", checkedInPolicyPath,
    "--private-key", privateKeyPath,
    "--key-id", "right-key",
    "--output", outputPath,
  ]);
  assert.equal(closed.status, 0, closed.stderr);

  const artifactFiles = await listFilesRecursively(join(outputPath, "artifacts"));
  const [sampleArtifactFile] = artifactFiles;
  assert.ok(sampleArtifactFile);
  const relativeArtifactPath = relative(outputPath, sampleArtifactFile);

  const beforeSnapshot = await snapshotFiles(await listFilesRecursively(outputPath));
  const readOnlyRun = await runCli([
    "verify-closure",
    "--registry-root", outputPath,
    "--public-key", publicKeyPath,
    "--key-id", "right-key",
    "--verify-artifacts",
  ]);
  assert.equal(readOnlyRun.status, 0, readOnlyRun.stderr);
  assert.deepEqual(await snapshotFiles(await listFilesRecursively(outputPath)), beforeSnapshot);

  const tamperedBytesRoot = join(root, "tampered-bytes");
  await copyTreePreservingModes(outputPath, tamperedBytesRoot);
  const tamperedBytesFile = join(tamperedBytesRoot, relativeArtifactPath);
  await writeFile(tamperedBytesFile, Buffer.concat([await readFile(tamperedBytesFile), Buffer.from("tampered")]));

  const byteTamperWithArtifacts = await runCli([
    "verify-closure",
    "--registry-root", tamperedBytesRoot,
    "--public-key", publicKeyPath,
    "--key-id", "right-key",
    "--verify-artifacts",
  ]);
  assert.equal(byteTamperWithArtifacts.status, 2);
  assert.equal(byteTamperWithArtifacts.stderr, "DIGEST_MISMATCH: Artifact digest does not match admitted package\n");

  const byteTamperWithoutArtifacts = await runCli([
    "verify-closure",
    "--registry-root", tamperedBytesRoot,
    "--public-key", publicKeyPath,
    "--key-id", "right-key",
  ]);
  assert.equal(byteTamperWithoutArtifacts.status, 0, byteTamperWithoutArtifacts.stderr);

  const tamperedModeRoot = join(root, "tampered-mode");
  await copyTreePreservingModes(outputPath, tamperedModeRoot);
  const tamperedModeFile = join(tamperedModeRoot, relativeArtifactPath);
  const currentMode = (await stat(tamperedModeFile)).mode & 0o777;
  await chmod(tamperedModeFile, currentMode === 0o644 ? 0o755 : 0o644);

  const modeTamper = await runCli([
    "verify-closure",
    "--registry-root", tamperedModeRoot,
    "--public-key", publicKeyPath,
    "--key-id", "right-key",
    "--verify-artifacts",
  ]);
  assert.equal(modeTamper.status, 2);
  assert.match(modeTamper.stderr, /^MODE_MISMATCH: Artifact file mode does not match the declared mode: /);
});
