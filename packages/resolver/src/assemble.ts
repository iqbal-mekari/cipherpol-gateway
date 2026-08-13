import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Generation } from "@cipherpol/contracts";
import { digestDirectory } from "./digest.js";
import { CipherpolError } from "./errors.js";

function inside(root: string, child: string): string {
  const base = resolve(root);
  const target = resolve(root, child);
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new CipherpolError("UNSAFE_PATH", `Path escapes root: ${child}`);
  }
  return target;
}

export async function assembleRuntime(generation: Generation, registryRoot: string, output: string): Promise<void> {
  const stage = `${output}.stage-${process.pid}`;
  const backup = `${output}.backup-${process.pid}`;
  const targets = new Set<string>();
  let movedCurrent = false;
  await rm(stage, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  try {
    for (const pkg of generation.packages) {
      const artifact = inside(registryRoot, pkg.artifactPath);
      const actual = await digestDirectory(artifact);
      if (actual !== pkg.digest) {
        throw new CipherpolError("ARTIFACT_MISMATCH", `Digest mismatch ${pkg.id}`, { expected: pkg.digest, actual });
      }
      for (const file of pkg.files) {
        const target = inside(stage, file.target);
        if (targets.has(target)) throw new CipherpolError("TARGET_COLLISION", `Collision ${file.target}`);
        targets.add(target);
        await mkdir(dirname(target), { recursive: true });
        await cp(inside(artifact, file.source), target, { errorOnExist: true });
      }
    }
    await writeFile(join(stage, "cipherpol-generation.json"), `${JSON.stringify(generation, null, 2)}\n`, { flag: "wx" });
    try {
      await rename(output, backup);
      movedCurrent = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(stage, output);
    } catch (error) {
      if (movedCurrent) await rename(backup, output);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(stage, { recursive: true, force: true });
    if (!movedCurrent) await rm(backup, { recursive: true, force: true });
  }
}
