#!/usr/bin/env node
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cipherpolLockSchema, type CipherpolLock, type CipherpolManifest, type Generation } from "@cipherpol/contracts";
import { assembleRuntime, CipherpolError, loadManifest } from "@cipherpol/resolver";
import { parseOptions, type ParsedOptions } from "./args.js";
import { GatewayClient, GatewayError } from "./client.js";
import { CliError } from "./errors.js";
import { decodeIdTokenEmail, login } from "./google-token.js";
import { materializeGeneration } from "./materialize.js";

function singleValue(options: ParsedOptions, flag: string): string | undefined {
  return options.values.get(flag)?.at(-1);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

async function lock(path: string): Promise<CipherpolLock | undefined> {
  try { return cipherpolLockSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function validateRegistryPath(registryRoot: string, generation: Generation): Promise<void> {
  try {
    const info = await stat(registryRoot);
    if (!info.isDirectory()) throw new CipherpolError("INVALID_REGISTRY", `Registry path is not a directory: ${registryRoot}`);
  } catch (error) {
    if (error instanceof CipherpolError) throw error;
    throw new CipherpolError("INVALID_REGISTRY", `Registry path does not exist: ${registryRoot}`);
  }
  const first = generation.packages[0];
  if (first === undefined) return;
  const artifactDir = resolve(registryRoot, first.artifactPath);
  try {
    const info = await stat(artifactDir);
    if (!info.isDirectory()) throw new CipherpolError("INVALID_REGISTRY", `Registry artifact directory is not a directory: ${artifactDir}`);
  } catch (error) {
    if (error instanceof CipherpolError) throw error;
    throw new CipherpolError("INVALID_REGISTRY", `Registry artifact directory does not exist: ${artifactDir}`);
  }
}

async function setupOrUpdate(options: ParsedOptions): Promise<void> {
  const cwd = process.cwd();
  const manifest = await loadManifest(resolve(cwd, "cipherpol.yaml"));
  const claudeCodeVersion = singleValue(options, "--claude-version");
  if (!claudeCodeVersion) throw new CliError("USAGE", "--claude-version is required");
  const capabilities = options.values.get("--capability") ?? [];

  const gateway = new GatewayClient();
  const generation = await gateway.resolveGeneration(manifest, { claudeCodeVersion, capabilities });

  const lockPath = resolve(cwd, "cipherpol.lock");
  const previous = await lock(lockPath);

  if (options.flags.has("--check")) {
    console.log(`available generation ${generation.generationId}`);
    console.log(`active generation ${previous?.generationId ?? "none"}`);
    return;
  }

  console.log(`resolved generation ${generation.generationId}`);
  for (const pkg of generation.packages) {
    console.log(`  ${pkg.id}@${pkg.version} ${pkg.digest}`);
  }

  const registryPath = nonEmpty(singleValue(options, "--registry"));
  const sourceRoot = nonEmpty(singleValue(options, "--source-root") ?? process.env.CIPHERPOL_SOURCE_ROOT);

  if (registryPath === undefined && sourceRoot === undefined) {
    console.log("resolved and verified against the live gateway; no runtime was materialized");
    console.log("to materialize a local runtime, pass --source-root <path> (or set CIPHERPOL_SOURCE_ROOT) or --registry <path>");
    return;
  }

  if (!options.flags.has("--yes")) throw new CipherpolError("UNRESOLVABLE_GENERATION", "Explicit activation requires confirmation");

  const runtimeDir = resolve(cwd, ".cipherpol/runtime");
  if (registryPath !== undefined) {
    const registryRoot = resolve(registryPath);
    await validateRegistryPath(registryRoot, generation);
    await assembleRuntime(generation, registryRoot, runtimeDir);
  } else if (sourceRoot !== undefined) {
    const snapshot = await gateway.getSnapshot(generation.channel);
    const closureMappings = snapshot.registryEnvelope.closureManifest.mappings.map(({ packageId, admissionPath }) => ({ packageId, admissionPath }));
    await materializeGeneration(generation, snapshot.admissionEnvelopes, closureMappings, resolve(sourceRoot), runtimeDir);
  }

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

async function doctor(options: ParsedOptions): Promise<void> {
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
    const result = await gateway.checkAuthentication();
    if (result.accepted) {
      authenticated = true;
      console.log(`authentication: ok (${result.email ?? "unknown email"})`);
    } else if (result.httpStatus === 401 || result.httpStatus === 403) {
      console.log("authentication: rejected by gateway (wrong Google account domain, or token expired)");
    } else {
      console.log(`authentication: check failed (HTTP ${result.httpStatus})`);
    }
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

  const claudeCodeVersion = singleValue(options, "--claude-version");
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

  const capabilities = options.values.get("--capability") ?? [];
  try {
    const current = await gateway.resolveGeneration(manifest, { claudeCodeVersion, capabilities });
    if (current.generationId === previous.generationId) {
      console.log(`active generation ${previous.generationId}: current`);
    } else {
      console.log(`active generation ${previous.generationId}: stale (gateway now resolves ${current.generationId})`);
    }
  } catch (error) {
    console.log(`staleness: failed (${(error as Error).message})`);
  }
}

async function loginCommand(): Promise<void> {
  const idToken = await login();
  const email = decodeIdTokenEmail(idToken);
  if (email === undefined) {
    console.log("logged in");
  } else {
    console.log(`logged in as ${email}`);
  }
}

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === "login") {
    if (rest.length > 0) throw new CliError("USAGE", "Usage: cipherpol login");
    await loginCommand();
    return;
  }
  if (command !== "setup" && command !== "update" && command !== "doctor") {
    throw new CliError("USAGE", "Usage: cipherpol <setup|update|doctor|login>");
  }
  const options = parseOptions(rest);
  if (command === "setup" || command === "update") return setupOrUpdate(options);
  return doctor(options);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof CliError || error instanceof CipherpolError || error instanceof GatewayError) {
    console.error(error.message);
    process.exitCode = 2;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
});
