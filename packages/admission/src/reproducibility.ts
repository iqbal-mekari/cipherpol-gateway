import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { type FileHandle, lstat, open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CipherpolAdmissionError } from "./errors.js";

/**
 * One comparable filesystem entry within a closure tree: a relative POSIX path, its
 * normalized permission bits, and the SHA-256 digest of its exact bytes. Only regular
 * files are represented; directories are traversed but never compared directly.
 */
export interface ReproducibleTreeEntry {
  readonly path: string;
  readonly mode: number;
  readonly digest: string;
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

function unsafeTreeEntry(relativePath: string, reason: "symbolic-link" | "special"): never {
  throw new CipherpolAdmissionError(
    "UNSAFE_ARTIFACT_FILE",
    reason === "symbolic-link"
      ? `Closure tree entry must not be a symbolic link: ${relativePath}`
      : `Closure tree entry must be a regular file: ${relativePath}`,
    { path: relativePath },
  );
}

function treeEntryChanged(relativePath: string, fileType: "file" | "directory"): never {
  throw new CipherpolAdmissionError(
    "UNSAFE_ARTIFACT_FILE",
    `Closure tree ${fileType} changed during collection: ${relativePath || "."}`,
    { path: relativePath, fileType, reason: "changed-during-collection" },
  );
}

/**
 * Collects every regular file under `root` into comparable {@link ReproducibleTreeEntry}
 * records using the same TOCTOU-hardened discipline as `@cipherpol/resolver`'s
 * `collectFile`/`collectDirectory` and this package's own `collectArtifact`: every path
 * is opened with `O_NOFOLLOW` so a symbolic link surfaces as `ELOOP` on open rather than
 * being silently followed, the open handle's `fstat` identity (dev/ino) is checked
 * against the initial `lstat`, and — for files — the handle is re-`fstat`ed after the
 * read to confirm size, mtime, ctime, and identity are unchanged, so a file swapped or
 * mutated between the initial stat and the read is rejected instead of silently hashing
 * stale or partial bytes. Directories receive the identical before/after identity check
 * around their listing.
 */
async function collectTree(root: string): Promise<ReadonlyMap<string, ReproducibleTreeEntry>> {
  const canonicalRoot = resolve(root);
  const entries = new Map<string, ReproducibleTreeEntry>();

  async function collectFile(path: string, relativePath: string, pathStat: BigIntStats): Promise<void> {
    let file: FileHandle;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        unsafeTreeEntry(relativePath, "symbolic-link");
      }
      throw error;
    }

    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) {
        unsafeTreeEntry(relativePath, "special");
      }
      if (!sameIdentity(pathStat, before)) {
        treeEntryChanged(relativePath, "file");
      }

      const content = await file.readFile();
      const after = await file.stat({ bigint: true });
      if (!stableMetadata(before, after)) {
        treeEntryChanged(relativePath, "file");
      }

      entries.set(relativePath, {
        path: relativePath,
        mode: Number(before.mode & 0o777n),
        digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      });
    } finally {
      await file.close();
    }
  }

  async function collectDirectory(path: string, relativePath: string, pathStat: BigIntStats): Promise<void> {
    let directory: FileHandle;
    try {
      directory = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        unsafeTreeEntry(relativePath, "symbolic-link");
      }
      throw error;
    }

    try {
      const before = await directory.stat({ bigint: true });
      if (!before.isDirectory()) {
        unsafeTreeEntry(relativePath, "special");
      }
      if (!sameIdentity(pathStat, before)) {
        treeEntryChanged(relativePath, "directory");
      }

      const children = (await readdir(path, { withFileTypes: true }))
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      for (const child of children) {
        const childPath = join(path, child.name);
        const childRelativePath = relativePath === "" ? child.name : `${relativePath}/${child.name}`;
        await collectEntry(childPath, childRelativePath);
      }

      const [after, pathAfter] = await Promise.all([
        directory.stat({ bigint: true }),
        lstat(path, { bigint: true }),
      ]);
      if (
        !after.isDirectory()
        || !pathAfter.isDirectory()
        || !stableMetadata(before, after)
        || !sameIdentity(after, pathAfter)
      ) {
        treeEntryChanged(relativePath, "directory");
      }
    } finally {
      await directory.close();
    }
  }

  async function collectEntry(path: string, relativePath: string): Promise<void> {
    const stat = await lstat(path, { bigint: true });
    if (stat.isSymbolicLink()) {
      unsafeTreeEntry(relativePath, "symbolic-link");
    }
    if (stat.isDirectory()) {
      await collectDirectory(path, relativePath, stat);
      return;
    }
    if (!stat.isFile()) {
      unsafeTreeEntry(relativePath, "special");
    }
    await collectFile(path, relativePath, stat);
  }

  await collectEntry(canonicalRoot, "");
  return entries;
}

/**
 * Proves two independently built closure trees are byte-for-byte and mode-for-mode
 * identical. Collects only relative paths, normalized modes, and byte digests from
 * both roots; symbolic links and special files are rejected rather than silently
 * skipped. Succeeds silently when the trees match. On the first divergence — a path
 * present in only one tree, a mode mismatch, or a digest mismatch — throws a typed
 * {@link CipherpolAdmissionError} identifying the differing path deterministically,
 * always in code-point path order so repeated comparisons of the same divergent
 * inputs report the same first difference.
 */
export async function compareClosureTrees(leftRoot: string, rightRoot: string): Promise<void> {
  const [left, right] = await Promise.all([collectTree(leftRoot), collectTree(rightRoot)]);
  const paths = [...new Set([...left.keys(), ...right.keys()])]
    .sort((leftPath, rightPath) => (leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0));

  for (const path of paths) {
    const leftEntry = left.get(path);
    const rightEntry = right.get(path);
    if (leftEntry === undefined) {
      throw new CipherpolAdmissionError(
        "REPRODUCIBILITY_MISMATCH",
        `Closure tree entry is missing from the first build: ${path}`,
        { path, missingFrom: "left" },
      );
    }
    if (rightEntry === undefined) {
      throw new CipherpolAdmissionError(
        "REPRODUCIBILITY_MISMATCH",
        `Closure tree entry is missing from the second build: ${path}`,
        { path, missingFrom: "right" },
      );
    }
    if (leftEntry.mode !== rightEntry.mode) {
      throw new CipherpolAdmissionError(
        "REPRODUCIBILITY_MISMATCH",
        `Closure tree entry mode differs between builds: ${path}`,
        { path, leftMode: leftEntry.mode, rightMode: rightEntry.mode },
      );
    }
    if (leftEntry.digest !== rightEntry.digest) {
      throw new CipherpolAdmissionError(
        "REPRODUCIBILITY_MISMATCH",
        `Closure tree entry digest differs between builds: ${path}`,
        { path },
      );
    }
  }
}
