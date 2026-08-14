import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { CipherpolAdmissionError } from "./errors.js";
import type {
  ImportedArtifactDescriptor,
  SoftwareDevAgenticImportResult,
} from "./importer.js";

export interface MaterializedFile {
  readonly source: string;
  readonly target: string;
  readonly mode: 0o644 | 0o755;
}

export interface MaterializedPackage {
  readonly descriptor: ImportedArtifactDescriptor;
  readonly artifactRoot: string;
  readonly artifactPath: string;
  readonly files: readonly MaterializedFile[];
}

export interface MaterializedClosure {
  readonly root: string;
  readonly packages: readonly MaterializedPackage[];
  readonly skillsDirectory: string;
  readonly agentsDirectory: string;
}

interface SourceRootGuard {
  readonly path: string;
  readonly handle: FileHandle;
  readonly stats: Stats;
}

interface CollectedFile {
  readonly bytes: Buffer;
  readonly mode: 0o644 | 0o755;
}

interface PlannedFile extends CollectedFile, MaterializedFile {}

interface PlannedPackage extends MaterializedPackage {
  readonly plannedFiles: readonly PlannedFile[];
}

const STABLE_PACKAGE_ID = /^[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/;

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function provenanceFailure(message: string, details: Record<string, unknown> = {}): never {
  throw new CipherpolAdmissionError("PROVENANCE_MISMATCH", message, details);
}

function collisionFailure(message: string, details: Record<string, unknown>): never {
  throw new CipherpolAdmissionError("TARGET_COLLISION", message, details);
}

function claimOutputFile(
  files: Map<string, string>,
  directories: Set<string>,
  path: string,
  packageId: string,
  label: string,
): void {
  const priorPackageId = files.get(path);
  if (priorPackageId !== undefined || directories.has(path)) {
    collisionFailure(`${label} collides with another materialized output`, {
      path,
      packageId,
      priorPackageId,
    });
  }
  let parent = posix.dirname(path);
  while (parent !== ".") {
    const parentOwner = files.get(parent);
    if (parentOwner !== undefined) {
      collisionFailure(`${label} traverses another materialized file`, {
        path,
        packageId,
        priorPath: parent,
        priorPackageId: parentOwner,
      });
    }
    directories.add(parent);
    parent = posix.dirname(parent);
  }
  files.set(path, packageId);
}

function pathIsWithinRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableMetadata(left: Stats, right: Stats): boolean {
  return sameIdentity(left, right)
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function noFollowFlags(directory: boolean): number {
  if (typeof constants.O_NOFOLLOW !== "number") {
    return provenanceFailure("Platform does not support no-follow authored source opens");
  }
  const directoryOnly = directory && typeof constants.O_DIRECTORY === "number"
    ? constants.O_DIRECTORY
    : 0;
  return constants.O_RDONLY | constants.O_NOFOLLOW | directoryOnly;
}

async function canonicalSourceRoot(sourceRoot: string): Promise<SourceRootGuard> {
  const suppliedRoot = resolve(sourceRoot);
  let initial: Stats;
  try {
    initial = await lstat(suppliedRoot);
  } catch (error) {
    return provenanceFailure("Source root is missing or unreadable", {
      sourceRoot: suppliedRoot,
      error: errorMessage(error),
    });
  }
  if (initial.isSymbolicLink() || !initial.isDirectory()) {
    return provenanceFailure("Source root must be a non-symbolic-link directory", {
      sourceRoot: suppliedRoot,
    });
  }

  let canonical: string;
  let handle: FileHandle | undefined;
  try {
    canonical = await realpath(suppliedRoot);
    handle = await open(suppliedRoot, noFollowFlags(true));
    const opened = await handle.stat();
    const current = await lstat(suppliedRoot);
    if (!opened.isDirectory() || !sameIdentity(initial, opened) || !sameIdentity(opened, current)) {
      return provenanceFailure("Source root changed while opening", { sourceRoot: suppliedRoot });
    }
    return { path: canonical, handle, stats: opened };
  } catch (error) {
    await handle?.close();
    if (error instanceof CipherpolAdmissionError) throw error;
    return provenanceFailure("Source root cannot be securely opened", {
      sourceRoot: suppliedRoot,
      error: errorMessage(error),
    });
  }
}

function portableSourcePath(sourcePath: string, packageId: string): readonly string[] {
  if (
    sourcePath.length === 0
    || sourcePath.startsWith("/")
    || sourcePath.includes("\\")
  ) {
    return provenanceFailure("Descriptor source path must be a portable relative path", {
      packageId,
      sourcePath,
    });
  }
  const segments = sourcePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return provenanceFailure("Descriptor source path contains an unsafe segment", {
      packageId,
      sourcePath,
    });
  }
  return segments;
}

function portableTargetPath(targetPath: string, packageId: string, allowDot = false): string {
  if (allowDot && targetPath === ".") return targetPath;
  if (
    targetPath.length === 0
    || targetPath.startsWith("/")
    || targetPath.includes("\\")
  ) {
    return provenanceFailure("Descriptor target path must be a portable relative path", {
      packageId,
      targetPath,
    });
  }
  const segments = targetPath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return provenanceFailure("Descriptor target path contains an unsafe segment", {
      packageId,
      targetPath,
    });
  }
  return segments.join("/");
}

function stablePackageIdPath(descriptor: ImportedArtifactDescriptor): string {
  if (!STABLE_PACKAGE_ID.test(descriptor.packageId)) {
    return provenanceFailure("Materialization package ID is not a stable path-safe ID", {
      packageId: descriptor.packageId,
    });
  }
  if (
    descriptor.moduleVersion.length === 0
    || descriptor.moduleVersion === "."
    || descriptor.moduleVersion === ".."
    || descriptor.moduleVersion.includes("/")
    || descriptor.moduleVersion.includes("\\")
  ) {
    return provenanceFailure("Materialization module version is not a safe path segment", {
      packageId: descriptor.packageId,
      moduleVersion: descriptor.moduleVersion,
    });
  }
  const idPath = descriptor.packageId
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return posix.join(idPath, encodeURIComponent(descriptor.moduleVersion));
}

async function verifyPathComponents(
  sourceRoot: string,
  segments: readonly string[],
  packageId: string,
): Promise<string> {
  let current = sourceRoot;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) {
      return provenanceFailure("Descriptor source path has an invalid segment", { packageId });
    }
    current = join(current, segment);
    let stats: Stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      return provenanceFailure("Descriptor source path is missing or unreadable", {
        packageId,
        sourcePath: segments.join("/"),
        error: errorMessage(error),
      });
    }
    if (stats.isSymbolicLink()) {
      return provenanceFailure("Descriptor source path contains a symbolic link", {
        packageId,
        sourcePath: segments.join("/"),
        symlink: segments.slice(0, index + 1).join("/"),
      });
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      return provenanceFailure("Descriptor source path traverses a non-directory", {
        packageId,
        sourcePath: segments.join("/"),
      });
    }
  }

  let canonical: string;
  try {
    canonical = await realpath(current);
  } catch (error) {
    return provenanceFailure("Descriptor source path cannot be canonicalized", {
      packageId,
      sourcePath: segments.join("/"),
      error: errorMessage(error),
    });
  }
  if (!pathIsWithinRoot(sourceRoot, canonical) || canonical === sourceRoot) {
    return provenanceFailure("Descriptor source realpath escapes the source root", {
      packageId,
      sourcePath: segments.join("/"),
    });
  }
  return current;
}

async function collectRegularFile(
  sourceRoot: string,
  absolutePath: string,
  sourcePath: string,
  packageId: string,
): Promise<CollectedFile> {
  let before: Stats;
  let handle: FileHandle | undefined;
  try {
    before = await lstat(absolutePath);
    if (before.isSymbolicLink() || !before.isFile()) {
      return provenanceFailure("Authored source is not a regular file", { packageId, sourcePath });
    }
    const canonical = await realpath(absolutePath);
    if (!pathIsWithinRoot(sourceRoot, canonical)) {
      return provenanceFailure("Authored source realpath escapes the source root", {
        packageId,
        sourcePath,
      });
    }

    handle = await open(absolutePath, noFollowFlags(false));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      return provenanceFailure("Authored source changed while opening", { packageId, sourcePath });
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(absolutePath);
    if (!sameStableMetadata(opened, after) || !sameIdentity(after, current) || current.isSymbolicLink()) {
      return provenanceFailure("Authored source changed while reading", { packageId, sourcePath });
    }
    return {
      bytes,
      mode: (opened.mode & 0o111) === 0 ? 0o644 : 0o755,
    };
  } catch (error) {
    if (error instanceof CipherpolAdmissionError) throw error;
    return provenanceFailure("Authored source cannot be securely read", {
      packageId,
      sourcePath,
      error: errorMessage(error),
    });
  } finally {
    await handle?.close();
  }
}

async function collectDirectory(
  sourceRoot: string,
  absoluteDirectory: string,
  sourcePath: string,
  packageId: string,
  fileCache: Map<string, Promise<CollectedFile>>,
): Promise<Array<Readonly<{ relativePath: string; file: CollectedFile }>>> {
  let before: Stats;
  let handle: FileHandle | undefined;
  try {
    before = await lstat(absoluteDirectory);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      return provenanceFailure("Authored source is not a directory", { packageId, sourcePath });
    }
    handle = await open(absoluteDirectory, noFollowFlags(true));
    const opened = await handle.stat();
    if (!opened.isDirectory() || !sameIdentity(before, opened)) {
      return provenanceFailure("Authored source directory changed while opening", {
        packageId,
        sourcePath,
      });
    }

    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((left, right) => compareCodePoints(left.name, right.name));
    const collected: Array<Readonly<{ relativePath: string; file: CollectedFile }>> = [];
    for (const child of children) {
      const childAbsolute = join(absoluteDirectory, child.name);
      const childSourcePath = `${sourcePath}/${child.name}`;
      const childStats = await lstat(childAbsolute);
      if (childStats.isSymbolicLink()) {
        return provenanceFailure("Authored source directory contains a symbolic link", {
          packageId,
          sourcePath: childSourcePath,
        });
      }
      if (childStats.isDirectory()) {
        const descendants = await collectDirectory(
          sourceRoot,
          childAbsolute,
          childSourcePath,
          packageId,
          fileCache,
        );
        for (const descendant of descendants) {
          collected.push({
            relativePath: `${child.name}/${descendant.relativePath}`,
            file: descendant.file,
          });
        }
        continue;
      }
      if (!childStats.isFile()) {
        return provenanceFailure("Authored source directory contains a special file", {
          packageId,
          sourcePath: childSourcePath,
        });
      }
      let pending = fileCache.get(childAbsolute);
      if (pending === undefined) {
        pending = collectRegularFile(sourceRoot, childAbsolute, childSourcePath, packageId);
        fileCache.set(childAbsolute, pending);
      }
      collected.push({ relativePath: child.name, file: await pending });
    }

    const after = await handle.stat();
    const current = await lstat(absoluteDirectory);
    if (!sameStableMetadata(opened, after) || !sameIdentity(after, current) || current.isSymbolicLink()) {
      return provenanceFailure("Authored source directory changed while collecting", {
        packageId,
        sourcePath,
      });
    }
    return collected;
  } catch (error) {
    if (error instanceof CipherpolAdmissionError) throw error;
    return provenanceFailure("Authored source directory cannot be securely collected", {
      packageId,
      sourcePath,
      error: errorMessage(error),
    });
  } finally {
    await handle?.close();
  }
}

function addPlannedFile(
  files: Map<string, PlannedFile>,
  targets: Set<string>,
  source: string,
  target: string,
  collected: CollectedFile,
  packageId: string,
): void {
  const safeSource = portableTargetPath(source, packageId);
  const safeTarget = portableTargetPath(target, packageId);
  if (files.has(safeSource)) {
    collisionFailure("Descriptor sources produce a duplicate artifact output path", {
      packageId,
      source: safeSource,
    });
  }
  if (targets.has(safeTarget)) {
    collisionFailure("Descriptor sources produce a duplicate runtime target", {
      packageId,
      target: safeTarget,
    });
  }
  files.set(safeSource, { source: safeSource, target: safeTarget, ...collected });
  targets.add(safeTarget);
}

async function planPackage(
  sourceRoot: string,
  outputRoot: string,
  descriptor: ImportedArtifactDescriptor,
  fileCache: Map<string, Promise<CollectedFile>>,
): Promise<PlannedPackage> {
  if (descriptor.sourcePaths.length === 0) {
    return provenanceFailure("Materialization descriptor has no authored source", {
      packageId: descriptor.packageId,
    });
  }
  if (descriptor.sourceKind !== "cp1-adapter" && descriptor.sourcePaths.length !== 1) {
    return provenanceFailure("Non-adapter descriptor must select exactly one authored source", {
      packageId: descriptor.packageId,
      sourcePaths: descriptor.sourcePaths,
    });
  }

  const targetRoot = portableTargetPath(
    descriptor.targetRoot,
    descriptor.packageId,
    descriptor.sourceKind === "cp1-adapter",
  );
  if (descriptor.sourceKind === "cp1-adapter" && targetRoot !== ".") {
    return provenanceFailure("cp1 adapter descriptor target root must be '.'", {
      packageId: descriptor.packageId,
      targetRoot,
    });
  }

  const files = new Map<string, PlannedFile>();
  const targets = new Set<string>();
  for (const sourcePath of descriptor.sourcePaths) {
    const segments = portableSourcePath(sourcePath, descriptor.packageId);
    if (descriptor.sourceKind === "cp1-adapter") {
      if (segments[0] !== descriptor.module || segments.includes("dist")) {
        return provenanceFailure("cp1 adapter source must be an authored module path without dist", {
          packageId: descriptor.packageId,
          sourcePath,
        });
      }
    }
    const absolutePath = await verifyPathComponents(sourceRoot, segments, descriptor.packageId);
    const stats = await lstat(absolutePath);

    if (descriptor.sourceKind === "file") {
      if (!stats.isFile() || stats.isSymbolicLink()) {
        return provenanceFailure("File descriptor source is not a regular file", {
          packageId: descriptor.packageId,
          sourcePath,
        });
      }
      let pending = fileCache.get(absolutePath);
      if (pending === undefined) {
        pending = collectRegularFile(sourceRoot, absolutePath, sourcePath, descriptor.packageId);
        fileCache.set(absolutePath, pending);
      }
      addPlannedFile(
        files,
        targets,
        posix.basename(sourcePath),
        targetRoot,
        await pending,
        descriptor.packageId,
      );
      continue;
    }

    if (descriptor.sourceKind === "directory" && (!stats.isDirectory() || stats.isSymbolicLink())) {
      return provenanceFailure("Directory descriptor source is not a directory", {
        packageId: descriptor.packageId,
        sourcePath,
      });
    }
    if (descriptor.sourceKind === "cp1-adapter" && !stats.isDirectory() && !stats.isFile()) {
      return provenanceFailure("cp1 adapter source is not a regular file or directory", {
        packageId: descriptor.packageId,
        sourcePath,
      });
    }

    const adapterPrefix = segments.slice(1).join("/");
    if (stats.isFile()) {
      let pending = fileCache.get(absolutePath);
      if (pending === undefined) {
        pending = collectRegularFile(sourceRoot, absolutePath, sourcePath, descriptor.packageId);
        fileCache.set(absolutePath, pending);
      }
      addPlannedFile(
        files,
        targets,
        adapterPrefix,
        `adapters/cp1/${adapterPrefix}`,
        await pending,
        descriptor.packageId,
      );
      continue;
    }

    const collectedDirectory = await collectDirectory(
      sourceRoot,
      absolutePath,
      sourcePath,
      descriptor.packageId,
      fileCache,
    );
    for (const collected of collectedDirectory) {
      if (descriptor.sourceKind === "cp1-adapter") {
        const source = `${adapterPrefix}/${collected.relativePath}`;
        if (source.split("/").includes("dist")) {
          return provenanceFailure("cp1 adapter directory contains generated dist output", {
            packageId: descriptor.packageId,
            sourcePath: source,
          });
        }
        addPlannedFile(
          files,
          targets,
          source,
          `adapters/cp1/${source}`,
          collected.file,
          descriptor.packageId,
        );
      } else {
        addPlannedFile(
          files,
          targets,
          collected.relativePath,
          `${targetRoot}/${collected.relativePath}`,
          collected.file,
          descriptor.packageId,
        );
      }
    }
  }

  if (files.size === 0) {
    return provenanceFailure("Materialization descriptor selects no authored files", {
      packageId: descriptor.packageId,
    });
  }

  const packagePath = stablePackageIdPath(descriptor);
  const artifactPath = posix.join("artifacts", packagePath);
  const artifactRoot = join(outputRoot, ...artifactPath.split("/"));
  const plannedFiles = [...files.values()].sort((left, right) => compareCodePoints(left.source, right.source));
  return {
    descriptor,
    artifactRoot,
    artifactPath,
    files: plannedFiles.map(({ source, target, mode }) => ({ source, target, mode })),
    plannedFiles,
  };
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o755 });
  await chmod(path, 0o755);
}

async function writePlannedFile(path: string, file: CollectedFile): Promise<void> {
  await ensureDirectory(resolve(path, ".."));
  await writeFile(path, file.bytes, { flag: "wx", mode: file.mode });
  await chmod(path, file.mode);
}

async function canonicalOutputRoot(outputRoot: string): Promise<string> {
  const suppliedRoot = resolve(outputRoot);
  try {
    await mkdir(suppliedRoot, { recursive: true, mode: 0o755 });
    const stats = await lstat(suppliedRoot);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("output root is not a non-symbolic-link directory");
    }
    return await realpath(suppliedRoot);
  } catch (error) {
    throw new CipherpolAdmissionError("ARTIFACT_IO_ERROR", "Output root cannot be prepared", {
      outputRoot: suppliedRoot,
      error: errorMessage(error),
    });
  }
}

export async function materializeClosure(input: {
  sourceRoot: string;
  outputRoot: string;
  imported: SoftwareDevAgenticImportResult;
}): Promise<MaterializedClosure> {
  if (input.imported.artifacts.length === 0) {
    return provenanceFailure("Imported closure contains no materialization descriptors");
  }

  const source = await canonicalSourceRoot(input.sourceRoot);
  try {
    const packageIds = new Set<string>();
    const artifactPaths = new Set<string>();
    const packageByRuntimeTarget = new Map<string, string>();
    const runtimeTargetDirectories = new Set<string>();
    const packageByArtifactFile = new Map<string, string>();
    const artifactDirectories = new Set<string>();
    const fileCache = new Map<string, Promise<CollectedFile>>();
    const requestedOutputRoot = resolve(input.outputRoot);
    if (pathIsWithinRoot(source.path, requestedOutputRoot)) {
      return provenanceFailure("Output root must remain outside the authored source root", {
        outputRoot: requestedOutputRoot,
      });
    }
    const descriptors = [...input.imported.artifacts]
      .sort((left, right) => compareCodePoints(left.packageId, right.packageId));
    const plannedPackages: PlannedPackage[] = [];
    for (const descriptor of descriptors) {
      if (packageIds.has(descriptor.packageId)) {
        throw new CipherpolAdmissionError(
          "DUPLICATE_PACKAGE_ID",
          "Imported closure contains a duplicate package ID",
          { packageId: descriptor.packageId },
        );
      }
      packageIds.add(descriptor.packageId);
      const planned = await planPackage(source.path, requestedOutputRoot, descriptor, fileCache);
      if (artifactPaths.has(planned.artifactPath)) {
        collisionFailure("Stable package IDs produce a duplicate artifact path", {
          packageId: descriptor.packageId,
          artifactPath: planned.artifactPath,
        });
      }
      artifactPaths.add(planned.artifactPath);
      for (const file of planned.plannedFiles) {
        claimOutputFile(
          packageByRuntimeTarget,
          runtimeTargetDirectories,
          file.target,
          descriptor.packageId,
          "Runtime target",
        );
        claimOutputFile(
          packageByArtifactFile,
          artifactDirectories,
          posix.join(planned.artifactPath, file.source),
          descriptor.packageId,
          "Artifact output",
        );
      }
      plannedPackages.push(planned);
    }

    const rootAfterCollection = await source.handle.stat();
    const currentRoot = await lstat(source.path);
    if (
      !sameStableMetadata(source.stats, rootAfterCollection)
      || !sameIdentity(rootAfterCollection, currentRoot)
      || currentRoot.isSymbolicLink()
    ) {
      return provenanceFailure("Source root changed while materializing the closure");
    }

    const gateFiles = new Map<string, CollectedFile>();
    for (const plannedPackage of plannedPackages) {
      for (const file of plannedPackage.plannedFiles) {
        if (!file.target.startsWith("skills/") && !file.target.startsWith("agents/")) continue;
        if (gateFiles.has(file.target)) {
          collisionFailure("Materialized packages collide in a gate view", {
            target: file.target,
            packageId: plannedPackage.descriptor.packageId,
          });
        }
        gateFiles.set(file.target, file);
      }
    }

    const outputRoot = await canonicalOutputRoot(requestedOutputRoot);
    const skillsDirectory = join(outputRoot, ".gates", "skills");
    const agentsDirectory = join(outputRoot, ".gates", "agents");
    try {
      await ensureDirectory(skillsDirectory);
      await ensureDirectory(agentsDirectory);
      for (const plannedPackage of plannedPackages) {
        for (const file of plannedPackage.plannedFiles) {
          await writePlannedFile(
            join(outputRoot, ...plannedPackage.artifactPath.split("/"), ...file.source.split("/")),
            file,
          );
        }
      }
      for (const [target, file] of [...gateFiles.entries()]
        .sort(([left], [right]) => compareCodePoints(left, right))) {
        await writePlannedFile(join(outputRoot, ".gates", ...target.split("/")), file);
      }
    } catch (error) {
      if (error instanceof CipherpolAdmissionError) throw error;
      throw new CipherpolAdmissionError("ARTIFACT_IO_ERROR", "Materialized closure cannot be written", {
        outputRoot,
        error: errorMessage(error),
      });
    }

    const packages: MaterializedPackage[] = plannedPackages.map((planned) => ({
      descriptor: planned.descriptor,
      artifactRoot: join(outputRoot, ...planned.artifactPath.split("/")),
      artifactPath: planned.artifactPath,
      files: planned.files,
    }));
    return { root: outputRoot, packages, skillsDirectory, agentsDirectory };
  } finally {
    await source.handle.close();
  }
}
