import { execFile } from "node:child_process";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { canonicalArtifactDigest, type Generation } from "@cipherpol/contracts";
import { CipherpolError } from "@cipherpol/resolver";
import { z } from "zod";

const execFileAsync = promisify(execFile);

/** A `{ packageId, admissionPath }` slice of a closure mapping, sufficient to anchor a package to its admission envelope. */
export interface ClosureMapping {
  readonly packageId: string;
  readonly admissionPath: string;
}

const admissionEnvelopeSchema = z.object({
  provenance: z.object({
    sourcePaths: z.array(z.string().min(1)).min(1),
    sourceRevision: z.string().min(7),
  }),
});

function inside(root: string, child: string): string {
  const base = resolve(root);
  const target = resolve(root, child);
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new CipherpolError("UNSAFE_PATH", `Path escapes root: ${child}`);
  }
  return target;
}

/**
 * Anchors a package's artifact-relative `files[].source` to a repo-root path
 * using the admission envelope's `provenance.sourcePaths`, applying the exact
 * kind-specific rules (adapter / agent+reference / skill+procedure). There is
 * deliberately no namespace-to-directory inverse mapping.
 */
function anchorRepoPath(kind: string, sourcePaths: readonly string[], source: string): string {
  const first = sourcePaths[0];
  if (first === undefined) {
    throw new CipherpolError("ARTIFACT_MISMATCH", `No source path recorded for ${source}`);
  }
  if (kind === "adapter") {
    const segment = first.split("/")[0];
    if (segment === undefined) throw new CipherpolError("ARTIFACT_MISMATCH", `Empty namespace segment in ${first}`);
    return `${segment}/${source}`;
  }
  if (kind === "agent" || kind === "reference") {
    return first;
  }
  if (kind === "skill" || kind === "procedure") {
    return `${first}/${source}`;
  }
  throw new CipherpolError("ARTIFACT_MISMATCH", `Unsupported package kind for materialization: ${kind}`);
}

async function readSourceFile(sourceRoot: string, revision: string, repoPath: string): Promise<Uint8Array> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", sourceRoot, "show", `${revision}:${repoPath}`],
      { encoding: "buffer" },
    );
    return stdout;
  } catch (error) {
    const detail = stderrText(error);
    throw new CipherpolError("ARTIFACT_MISMATCH", `Cannot read source file ${repoPath} at ${revision}`, {
      repoPath,
      revision,
      cause: detail.trim(),
    });
  }
}

async function readSourceMode(sourceRoot: string, revision: string, repoPath: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", sourceRoot, "ls-tree", revision, "--", repoPath]);
    const line = stdout.trim();
    if (line === "") return undefined;
    const mode = line.split(" ")[0];
    if (mode === undefined) return undefined;
    const parsed = Number.parseInt(mode, 8);
    return Number.isNaN(parsed) ? undefined : parsed & 0o777;
  } catch {
    return undefined;
  }
}

function stderrText(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === "string") return stderr;
  if (stderr instanceof Uint8Array) return new TextDecoder().decode(stderr);
  return error instanceof Error ? error.message : String(error);
}

/**
 * Materializes a resolved generation's packages from their source repository
 * into `outputDir`. Each package's bytes are fetched at its admitted source
 * revision, the canonical artifact digest is re-verified byte-for-byte, and
 * the resulting files are written with the same staging + atomic-rename
 * discipline as `assembleRuntime`.
 */
export async function materializeGeneration(
  generation: Generation,
  admissionEnvelopes: Readonly<Record<string, unknown>>,
  closureMappings: readonly ClosureMapping[],
  sourceRoot: string,
  outputDir: string,
): Promise<{ materializedPackages: number }> {
  const admissionPathByPackageId = new Map<string, string>();
  for (const mapping of closureMappings) {
    admissionPathByPackageId.set(mapping.packageId, mapping.admissionPath);
  }

  const stage = `${outputDir}.stage-${process.pid}`;
  const backup = `${outputDir}.backup-${process.pid}`;
  let movedCurrent = false;
  await rm(stage, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  try {
    let materializedPackages = 0;
    for (const pkg of generation.packages) {
      const admissionPath = admissionPathByPackageId.get(pkg.id);
      if (admissionPath === undefined) {
        throw new CipherpolError("ARTIFACT_MISMATCH", `No admission envelope mapping for ${pkg.id}`, { packageId: pkg.id });
      }
      const parsed = admissionEnvelopeSchema.safeParse(admissionEnvelopes[admissionPath]);
      if (!parsed.success) {
        throw new CipherpolError("ARTIFACT_MISMATCH", `Malformed admission envelope for ${pkg.id}`, {
          packageId: pkg.id,
          admissionPath,
          cause: parsed.error.message,
        });
      }
      const { sourcePaths, sourceRevision } = parsed.data.provenance;

      const files: Array<{ path: string; bytes: Uint8Array }> = [];
      for (const entry of pkg.files) {
        const repoPath = anchorRepoPath(pkg.kind, sourcePaths, entry.source);
        const bytes = await readSourceFile(sourceRoot, sourceRevision, repoPath);
        files.push({ path: entry.source, bytes });
      }

      const digest = canonicalArtifactDigest(files);
      if (digest !== pkg.digest) {
        throw new CipherpolError("ARTIFACT_MISMATCH", `Digest mismatch ${pkg.id}`, {
          expected: pkg.digest,
          actual: digest,
        });
      }

      for (let index = 0; index < pkg.files.length; index += 1) {
        const entry = pkg.files[index];
        const bytes = files[index]?.bytes;
        if (entry === undefined || bytes === undefined) continue;
        const target = inside(stage, entry.target);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes, { flag: "wx" });
        const mode = entry.mode ?? await readSourceMode(sourceRoot, sourceRevision, anchorRepoPath(pkg.kind, sourcePaths, entry.source));
        if (mode !== undefined) await chmod(target, mode);
      }
      materializedPackages += 1;
    }

    try {
      await rename(outputDir, backup);
      movedCurrent = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(stage, outputDir);
    } catch (error) {
      if (movedCurrent) await rename(backup, outputDir);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });

    return { materializedPackages };
  } finally {
    await rm(stage, { recursive: true, force: true });
    if (!movedCurrent) await rm(backup, { recursive: true, force: true });
  }
}
