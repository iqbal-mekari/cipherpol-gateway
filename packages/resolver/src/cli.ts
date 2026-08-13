#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cipherpolLockSchema, type CipherpolLock } from "@cipherpol/contracts";
import { assembleRuntime, CipherpolError, loadManifest, loadRegistry, resolveGeneration } from "./index.js";

const values = (flag: string, args: string[]) => args.flatMap((value, index) => args[index - 1] === flag ? [value] : []);
const value = (flag: string, args: string[]) => values(flag, args).at(-1);

async function lock(path: string): Promise<CipherpolLock | undefined> {
  try { return cipherpolLockSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function main(args: string[]): Promise<void> {
  const [command, ...options] = args;
  if (command !== "setup" && command !== "update") throw new Error("Usage: cipherpol-local <setup|update>");
  const cwd = process.cwd();
  const manifest = await loadManifest(resolve(cwd, "cipherpol.yaml"));
  const registry = await loadRegistry(resolve(value("--registry", options) ?? "fixtures/local-registry"));
  const claudeCodeVersion = value("--claude-version", options);
  if (!claudeCodeVersion) throw new Error("--claude-version is required");
  const generation = resolveGeneration(manifest, registry.index, {
    claudeCodeVersion, capabilities: new Set(values("--capability", options)),
  });
  const lockPath = resolve(cwd, "cipherpol.lock");
  const previous = await lock(lockPath);
  if (options.includes("--check")) {
    console.log(`available generation ${generation.generationId}`);
    console.log(`active generation ${previous?.generationId ?? "none"}`);
    return;
  }
  if (!options.includes("--yes")) throw new CipherpolError("UNRESOLVABLE_GENERATION", "Explicit activation requires confirmation");
  await assembleRuntime(generation, registry.root, resolve(cwd, ".cipherpol/runtime"));
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

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof CipherpolError) {
    console.error(`${error.code}: ${error.message}`);
    process.exitCode = 2;
  } else {
    console.error(error);
    process.exitCode = 1;
  }
});
