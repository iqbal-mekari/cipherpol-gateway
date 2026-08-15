#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cipherpolLockSchema, type CipherpolLock, type CipherpolManifest } from "@cipherpol/contracts";
import { assembleRuntime, CipherpolError, loadManifest } from "@cipherpol/resolver";
import { GatewayClient, GatewayError } from "./client.js";
import { getGoogleIdToken } from "./google-token.js";

const values = (flag: string, args: string[]) => args.flatMap((value, index) => args[index - 1] === flag ? [value] : []);
const value = (flag: string, args: string[]) => values(flag, args).at(-1);

async function lock(path: string): Promise<CipherpolLock | undefined> {
  try { return cipherpolLockSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function setupOrUpdate(options: string[]): Promise<void> {
  const cwd = process.cwd();
  const manifest = await loadManifest(resolve(cwd, "cipherpol.yaml"));
  const claudeCodeVersion = value("--claude-version", options);
  if (!claudeCodeVersion) throw new Error("--claude-version is required");
  const capabilities = values("--capability", options);

  const generation = await new GatewayClient().resolveGeneration(manifest, { claudeCodeVersion, capabilities });

  const lockPath = resolve(cwd, "cipherpol.lock");
  const previous = await lock(lockPath);

  if (options.includes("--check")) {
    console.log(`available generation ${generation.generationId}`);
    console.log(`active generation ${previous?.generationId ?? "none"}`);
    return;
  }

  console.log(`resolved generation ${generation.generationId}`);
  for (const pkg of generation.packages) {
    console.log(`  ${pkg.id}@${pkg.version} ${pkg.digest}`);
  }

  const registryPath = value("--registry", options);
  if (registryPath === undefined) {
    console.log("resolved and verified against the live registry; pass --registry <path> to also assemble a local runtime");
    return;
  }

  if (!options.includes("--yes")) throw new CipherpolError("UNRESOLVABLE_GENERATION", "Explicit activation requires confirmation");
  await assembleRuntime(generation, resolve(registryPath), resolve(cwd, ".cipherpol/runtime"));
  const now = new Date().toISOString();
  await writeFile(lockPath, `${JSON.stringify(cipherpolLockSchema.parse({
    schemaVersion: "cipherpol.lock/v1",
    generationId: generation.generationId,
    project: generation.project,
    channel: generation.channel,
    packages: generation.packages.map(({ id, version, digest }) => ({ id, version, digest })),
    activatedAt: now,
    previousHealthyGenerationId: previous?.generationId,
    health: { status: "healthy", checkedAt: now },
  }), null, 2)}\n`);
  console.log(`activated generation ${generation.generationId}`);
  console.log("run /reload-plugins to load the selected runtime");
}

async function doctor(options: string[]): Promise<void> {
  const cwd = process.cwd();
  const gateway = new GatewayClient();

  console.log(`gateway: ${gateway.baseUrl}`);
  try {
    const { ready } = await gateway.checkHealth();
    console.log(`reachability: ok (ready: ${ready ? "yes" : "no"})`);
  } catch (error) {
    console.log(`reachability: failed (${(error as Error).message})`);
    return;
  }

  let authenticated = false;
  try {
    await getGoogleIdToken();
    authenticated = true;
    console.log("authentication: ok");
  } catch (error) {
    console.log(`authentication: failed (${(error as Error).message})`);
  }

  const previous = await lock(resolve(cwd, "cipherpol.lock"));
  if (previous === undefined) {
    console.log("active generation: none (no cipherpol.lock in cwd)");
    return;
  }

  if (!authenticated) {
    console.log("staleness: skipped (authentication failed)");
    return;
  }

  const claudeCodeVersion = value("--claude-version", options);
  if (!claudeCodeVersion) {
    console.log("staleness: skipped (--claude-version required to re-resolve)");
    return;
  }

  let manifest: CipherpolManifest;
  try {
    manifest = await loadManifest(resolve(cwd, "cipherpol.yaml"));
  } catch (error) {
    console.log(`staleness: skipped (${(error as Error).message})`);
    return;
  }

  const capabilities = values("--capability", options);
  const current = await gateway.resolveGeneration(manifest, { claudeCodeVersion, capabilities });
  if (current.generationId === previous.generationId) {
    console.log(`active generation ${previous.generationId}: current`);
  } else {
    console.log(`active generation ${previous.generationId}: stale (gateway now resolves ${current.generationId})`);
  }
}

async function main(args: string[]): Promise<void> {
  const [command, ...options] = args;
  if (command === "setup" || command === "update") return setupOrUpdate(options);
  if (command === "doctor") return doctor(options);
  throw new Error("Usage: cipherpol <setup|update|doctor>");
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof CipherpolError || error instanceof GatewayError) {
    console.error(`${error.code}: ${error.message}`);
    process.exitCode = 2;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
});
