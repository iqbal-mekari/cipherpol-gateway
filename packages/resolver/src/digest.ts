import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { canonicalArtifactDigest, type CanonicalArtifactFile } from "@cipherpol/contracts";
import { CipherpolError } from "./errors.js";

export interface CollectedArtifact {
  readonly digest: string;
  readonly contentsByPath: ReadonlyMap<string, Buffer>;
  readonly modeByPath: ReadonlyMap<string, number>;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stableMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function unsafeArtifactFile(relativePath: string, fileType: "symbolic-link" | "special"): never {
  throw new CipherpolError(
    "UNSAFE_ARTIFACT_FILE",
    `${fileType === "symbolic-link" ? "Symbolic links" : "Special files"} are not allowed in a registry artifact: ${relativePath || "."}`,
    { filePath: relativePath || ".", fileType },
  );
}

function artifactChanged(relativePath: string, fileType: "file" | "directory"): never {
  throw new CipherpolError(
    "ARTIFACT_CHANGED",
    `Registry artifact ${fileType} changed during collection: ${relativePath || "."}`,
    { filePath: relativePath || ".", fileType },
  );
}

async function collectFile(
  path: string,
  relativePath: string,
  pathStat: BigIntStats,
  collected: Array<{ relativePath: string; content: Buffer; mode: number }>,
): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      unsafeArtifactFile(relativePath, "symbolic-link");
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      unsafeArtifactFile(relativePath, "special");
    }
    if (!sameIdentity(pathStat, before)) {
      artifactChanged(relativePath, "file");
    }
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!stableMetadata(before, after)) {
      artifactChanged(relativePath, "file");
    }
    collected.push({ relativePath, content, mode: Number(before.mode & 0o777n) });
  } finally {
    await handle.close();
  }
}

async function collectDirectory(
  path: string,
  relativePath: string,
  pathStat: BigIntStats,
  collected: Array<{ relativePath: string; content: Buffer; mode: number }>,
): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      unsafeArtifactFile(relativePath, "symbolic-link");
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isDirectory()) {
      unsafeArtifactFile(relativePath, "special");
    }
    if (!sameIdentity(pathStat, before)) {
      artifactChanged(relativePath, "directory");
    }

    const entries = (await readdir(path)).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    for (const name of entries) {
      const childRelativePath = relativePath === "" ? name : `${relativePath}/${name}`;
      await collectEntry(join(path, name), childRelativePath, collected);
    }

    const [after, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    if (
      !after.isDirectory()
      || !pathAfter.isDirectory()
      || !stableMetadata(before, after)
      || !sameIdentity(after, pathAfter)
    ) {
      artifactChanged(relativePath, "directory");
    }
  } finally {
    await handle.close();
  }
}

async function collectEntry(
  path: string,
  relativePath: string,
  collected: Array<{ relativePath: string; content: Buffer; mode: number }>,
): Promise<void> {
  const stat = await lstat(path, { bigint: true });
  if (stat.isSymbolicLink()) {
    unsafeArtifactFile(relativePath, "symbolic-link");
  }
  if (stat.isDirectory()) {
    await collectDirectory(path, relativePath, stat, collected);
    return;
  }
  if (!stat.isFile()) {
    unsafeArtifactFile(relativePath, "special");
  }
  await collectFile(path, relativePath, stat, collected);
}

/**
 * Collects every regular file under `root` with the same TOCTOU-hardened,
 * no-follow, fail-closed discipline used by `@cipherpol/admission`'s artifact
 * collector: symlinks and special files are rejected rather than silently
 * skipped, and file/directory identity is verified stable across the read.
 * Returns the canonical digest plus the exact bytes and source mode read for
 * every file, so a caller (such as `assembleRuntime`) can materialize files
 * from the same buffers that were hashed instead of re-opening the source a
 * second time, and can preserve the source's permission bits exactly when no
 * mode is declared on the package's file mapping.
 */
export async function collectArtifact(root: string): Promise<CollectedArtifact> {
  const collected: Array<{ relativePath: string; content: Buffer; mode: number }> = [];
  await collectEntry(root, "", collected);
  const files: CanonicalArtifactFile[] = collected.map((file) => ({
    path: file.relativePath.split(sep).join("/"),
    bytes: file.content,
  }));
  const contentsByPath = new Map<string, Buffer>();
  const modeByPath = new Map<string, number>();
  for (const [index, file] of files.entries()) {
    contentsByPath.set(file.path, collected[index]!.content);
    modeByPath.set(file.path, collected[index]!.mode);
  }
  return { digest: canonicalArtifactDigest(files), contentsByPath, modeByPath };
}

export async function digestDirectory(root: string): Promise<string> {
  return (await collectArtifact(root)).digest;
}
