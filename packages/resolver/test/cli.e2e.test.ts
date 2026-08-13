import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { digestDirectory } from "../src/index.js";

const execute = promisify(execFile);
const resolverRoot = resolve(".");
const cli = resolve("src/cli.ts");

async function environment(): Promise<{ cwd: string; registry: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "cipherpol-cli-"));
  const registry = join(cwd, "registry");
  const artifact = join(registry, "artifacts/task-router");
  await mkdir(artifact, { recursive: true });
  await writeFile(join(artifact, "task-router.md"), "# Router\n");
  const digest = await digestDirectory(artifact);
  await writeFile(join(cwd, "cipherpol.yaml"), `schemaVersion: cipherpol.mekari.com/v1
project: mobile-talenta
platforms: [flutter]
channel: stable
capabilityPacks: [cipherpol.aegis/pack/general]
playbooks: []
policyProfile: standard
owners: [mobile-platform]
`);
  await writeFile(join(registry, "index.yaml"), `schemaVersion: cipherpol.registry/v1
packages:
  - id: cipherpol.aegis/agent/task-router
    kind: agent
    version: 1.0.0
    digest: ${digest}
    owner: mobile-platform
    sourceRevision: 0123456789abcdef
    artifactPath: artifacts/task-router
    compatibility:
      claudeCode: ">=2.1.0 <3.0.0"
      capabilities: [plugins]
    dependencies: []
    files:
      - source: task-router.md
        target: agents/task-router.md
capabilityPacks:
  - id: cipherpol.aegis/pack/general
    version: 1.0.0
    intents: [engineering]
    platforms: [flutter, android, ios, web-nextjs, generic]
    orchestrator: cipherpol.aegis/agent/task-router@^1.0.0
    packages: [cipherpol.aegis/agent/task-router@^1.0.0]
    playbooks: []
    requiredEvidence: [focused-validation]
playbooks: []
`);
  return { cwd, registry };
}

function invocation(cwd: string, registry: string, ...operation: string[]) {
  return execute("npx", [
    "tsx", cli, ...operation,
    "--registry", registry, "--claude-version", "2.1.89", "--capability", "plugins",
  ], { cwd });
}

test("update check is read-only and confirmed setup writes a healthy lock", async () => {
  const data = await environment();
  assert.match((await invocation(data.cwd, data.registry, "update", "--check")).stdout, /available generation sha256:/);
  await assert.rejects(access(join(data.cwd, "cipherpol.lock")));
  assert.match((await invocation(data.cwd, data.registry, "setup", "--yes")).stdout, /activated generation sha256:/);
  const lock = JSON.parse(await readFile(join(data.cwd, "cipherpol.lock"), "utf8")) as { health: { status: string } };
  assert.equal(lock.health.status, "healthy");
});

test("unconfirmed setup exits two without mutation", async () => {
  const data = await environment();
  await assert.rejects(invocation(data.cwd, data.registry, "setup"), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === 2);
  await assert.rejects(access(join(data.cwd, "cipherpol.lock")));
  await assert.rejects(access(join(data.cwd, ".cipherpol/runtime")));
});
