import { createHash, KeyObject, sign, verify } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { type FileHandle, lstat, open, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import {
  canonicalJson,
  packageRecordSchema,
  type PackageRecord,
} from "@cipherpol/contracts";
import { validRange } from "semver";
import { z } from "zod";
import {
  checkAgentContextFromFiles,
  checkProceduresFromFiles,
} from "./checks.js";
import { CipherpolAdmissionError } from "./errors.js";
import { type PackageDependencyNode, validateDependencyGraph } from "./graph.js";
import { scanArtifactSecurity } from "./security.js";
import type { MaterializedClosure } from "./materialize.js";
import type { GeneratedPackageInput } from "./package-records.js";

const ADMISSION_SCHEMA_VERSION = "cipherpol.admission/v1" as const;
const SIGNATURE_ALGORITHM = "Ed25519" as const;

const relativePathSchema = z.string().min(1).refine(
  (path) => !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes(".."),
  "path must be relative and traversal-free",
);
const admittedPackageRecordSchema = packageRecordSchema.strict();

const provenanceSchema = z.object({
  sourceRepository: z.string().min(1),
  sourceRevision: z.string().min(7),
  sourcePaths: z.array(relativePathSchema),
}).strict();
const keyIdSchema = z.string()
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/,
    "key ID must be a stable identifier containing only letters, digits, dot, underscore, colon, or hyphen",
  );

const keyPurposeSchema = z.enum(["fixture", "production"]);

const base64Schema = z.string()
  .regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
    "signature must be canonical base64",
  )
  .refine((value) => Buffer.from(value, "base64").length === 64, "signature must be 64 bytes");

const admissionEnvelopeSchema = z.object({
  schemaVersion: z.literal(ADMISSION_SCHEMA_VERSION),
  packageRecord: admittedPackageRecordSchema,
  provenance: provenanceSchema,
  keyId: keyIdSchema,
  keyPurpose: keyPurposeSchema,
  algorithm: z.literal(SIGNATURE_ALGORITHM),
  signature: base64Schema,
}).strict();

export type PackageRecordMetadata = Omit<PackageRecord, "digest" | "revoked">;

export interface PackageProvenance {
  readonly sourceRepository: string;
  readonly sourceRevision: string;
  readonly sourcePaths: readonly string[];
}

export type PackageAdmissionInput = PackageRecordMetadata & {
  readonly provenance: PackageProvenance;
  readonly signingKey: KeyObject;
  readonly keyId: string;
  readonly keyPurpose: "fixture" | "production";
};

export interface AdmissionGateInputs {
  readonly packageSet: readonly PackageDependencyNode[];
  readonly skillsDirectory: string;
  readonly agentsDirectory: string;
}

export interface PackageAdmissionEnvelope {
  readonly schemaVersion: typeof ADMISSION_SCHEMA_VERSION;
  readonly packageRecord: PackageRecord;
  readonly provenance: {
    readonly sourceRepository: string;
    readonly sourceRevision: string;
    readonly sourcePaths: string[];
  };
  readonly keyId: string;
  readonly keyPurpose: "fixture" | "production";
  readonly algorithm: typeof SIGNATURE_ALGORITHM;
  readonly signature: string;
}

export interface AdmissionVerificationOptions {
  readonly trustedKeyId: string;
  readonly trustedPublicKey: KeyObject;
  readonly allowFixtureKeys: boolean;
  readonly artifactRoot?: string;
}

export interface AdmissionVerificationResult {
  readonly valid: true;
  readonly packageRecord: PackageRecord;
  readonly provenance: PackageAdmissionEnvelope["provenance"];
  readonly keyId: string;
}

function validationDetails(error: z.ZodError): Record<string, unknown> {
  return {
    issues: error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  };
}

function parseOrAdmissionError<Output, Input>(
  schema: z.ZodType<Output, z.ZodTypeDef, Input>,
  value: unknown,
  subject: string,
): Output {
  let result: z.SafeParseReturnType<Input, Output>;
  try {
    result = schema.safeParse(value);
  } catch (error) {
    throw new CipherpolAdmissionError(
      "INVALID_ADMISSION",
      `Unable to parse ${subject}`,
      error instanceof Error ? { causeName: error.name } : {},
    );
  }
  if (!result.success) {
    throw new CipherpolAdmissionError(
      "INVALID_ADMISSION",
      `Invalid ${subject}`,
      validationDetails(result.error),
    );
  }
  return result.data;
}

function normalizeArtifactPath(path: string): string {
  return posix.normalize(path);
}

function isAdmissionError(error: unknown): error is CipherpolAdmissionError {
  return error instanceof CipherpolAdmissionError;
}

function filesystemError(operation: string, error: unknown): CipherpolAdmissionError {
  const code = errorCode(error);
  return new CipherpolAdmissionError(
    "ARTIFACT_IO_ERROR",
    `Artifact filesystem operation failed: ${operation}`,
    code === undefined ? {} : { filesystemCode: code },
  );
}

function decodeTextFile(content: Buffer): string | undefined {
  if (content.includes(0)) {
    return undefined;
  }
  const text = content.toString("utf8");
  return Buffer.from(text, "utf8").equals(content) ? text : undefined;
}

interface CollectedArtifact {
  readonly digest: string;
  readonly regularFiles: ReadonlySet<string>;
  readonly contentsByPath: ReadonlyMap<string, Buffer>;
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

function artifactChanged(relativePath: string, fileType: "file" | "directory"): CipherpolAdmissionError {
  return new CipherpolAdmissionError(
    "UNSAFE_ARTIFACT_FILE",
    `Artifact ${fileType} changed during collection: ${relativePath || "."}`,
    {
      filePath: relativePath || ".",
      fileType,
      reason: "changed-during-collection",
    },
  );
}

function unsafeArtifactType(relativePath: string, fileType: "symbolic-link" | "special"): never {
  throw new CipherpolAdmissionError(
    "UNSAFE_ARTIFACT_FILE",
    `${fileType === "symbolic-link" ? "Symbolic links" : "Special files"} are not allowed in artifacts: ${relativePath || "."}`,
    { filePath: relativePath || ".", fileType },
  );
}

async function collectArtifact(root: string): Promise<CollectedArtifact> {
  const collectedFiles: Array<{ relativePath: string; content: Buffer }> = [];

  async function collectFile(path: string, relativePath: string, pathStat: BigIntStats): Promise<void> {
    let file: FileHandle;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (errorCode(error) === "ELOOP") {
        unsafeArtifactType(relativePath, "symbolic-link");
      }
      throw error;
    }

    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) {
        unsafeArtifactType(relativePath, "special");
      }
      if (!sameIdentity(pathStat, before)) {
        throw artifactChanged(relativePath, "file");
      }

      const content = await file.readFile();
      const after = await file.stat({ bigint: true });
      if (!stableMetadata(before, after)) {
        throw artifactChanged(relativePath, "file");
      }

      const normalizedPath = normalizeArtifactPath(relativePath);
      const text = decodeTextFile(content);
      if (text !== undefined) {
        scanArtifactSecurity(normalizedPath, text);
      }
      collectedFiles.push({ relativePath: normalizedPath, content });
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
      if (errorCode(error) === "ELOOP") {
        unsafeArtifactType(relativePath, "symbolic-link");
      }
      throw error;
    }

    try {
      const before = await directory.stat({ bigint: true });
      if (!before.isDirectory()) {
        unsafeArtifactType(relativePath, "special");
      }
      if (!sameIdentity(pathStat, before)) {
        throw artifactChanged(relativePath, "directory");
      }

      const entries = await readdir(path, { withFileTypes: true });
      entries.sort((left, right) => compareStrings(left.name, right.name));
      for (const entry of entries) {
        const childRelativePath = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
        await collect(join(path, entry.name), childRelativePath);
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
        throw artifactChanged(relativePath, "directory");
      }
    } finally {
      await directory.close();
    }
  }

  async function collect(path: string, relativePath: string): Promise<void> {
    const stat = await lstat(path, { bigint: true });
    if (stat.isSymbolicLink()) {
      unsafeArtifactType(relativePath, "symbolic-link");
    }
    if (stat.isDirectory()) {
      await collectDirectory(path, relativePath, stat);
      return;
    }
    if (!stat.isFile()) {
      unsafeArtifactType(relativePath, "special");
    }
    await collectFile(path, relativePath, stat);
  }

  try {
    await collect(root, "");
    const hash = createHash("sha256");
    const regularFiles = new Set<string>();
    const contentsByPath = new Map<string, Buffer>();
    collectedFiles.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
    for (const file of collectedFiles) {
      hash.update(file.relativePath);
      hash.update("\0");
      hash.update(file.content);
      hash.update("\0");
      regularFiles.add(file.relativePath);
      contentsByPath.set(file.relativePath, file.content);
    }
    return {
      digest: `sha256:${hash.digest("hex")}`,
      regularFiles,
      contentsByPath,
    };
  } catch (error) {
    if (isAdmissionError(error)) {
      throw error;
    }
    throw filesystemError("collect artifact", error);
  }
}

function validateDeclaredFiles(packageRecord: PackageRecord, regularFiles: ReadonlySet<string>): void {
  const targets = new Map<string, string>();
  for (const mapping of packageRecord.files) {
    const source = normalizeArtifactPath(mapping.source);
    if (!regularFiles.has(source)) {
      throw new CipherpolAdmissionError(
        "MISSING_SOURCE_FILE",
        `Declared source file is missing from artifact: ${mapping.source}`,
        { source: mapping.source },
      );
    }

    const target = normalizeArtifactPath(mapping.target);
    const priorSource = targets.get(target);
    if (priorSource !== undefined) {
      throw new CipherpolAdmissionError(
        "TARGET_COLLISION",
        `Multiple package files target the same path: ${target}`,
        { target, sources: [priorSource, mapping.source] },
      );
    }
    targets.set(target, mapping.source);
  }
}

type GateErrorCode = "INVALID_PROCEDURE_GRAPH" | "INVALID_AGENT_CONTEXT";

interface CollectedGateView {
  readonly contentsByPath: ReadonlyMap<string, Buffer>;
}

function gateViewError(
  code: GateErrorCode,
  directory: string,
  relativePath: string,
  reason: string,
  error?: unknown,
): CipherpolAdmissionError {
  const gateDirectory = code === "INVALID_PROCEDURE_GRAPH"
    ? { skillsDirectory: directory }
    : { agentsDirectory: directory };
  const filesystemCode = errorCode(error);
  return new CipherpolAdmissionError(
    code,
    `Unsafe checked flat view member: ${relativePath || "."}`,
    {
      ...gateDirectory,
      filePath: relativePath || ".",
      reason,
      ...(filesystemCode === undefined ? {} : { filesystemCode }),
    },
  );
}

async function collectGateView(
  root: string,
  code: GateErrorCode,
): Promise<CollectedGateView> {
  const contentsByPath = new Map<string, Buffer>();

  async function collectFile(
    path: string,
    relativePath: string,
    pathStat: BigIntStats,
  ): Promise<void> {
    let file: FileHandle;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      throw gateViewError(
        code,
        root,
        relativePath,
        errorCode(error) === "ELOOP" ? "symbolic-link" : "gate-view-io-error",
        error,
      );
    }

    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || !sameIdentity(pathStat, before)) {
        throw gateViewError(code, root, relativePath, "unsafe-gate-member");
      }
      const content = await file.readFile();
      const [after, pathAfter] = await Promise.all([
        file.stat({ bigint: true }),
        lstat(path, { bigint: true }),
      ]);
      if (
        !after.isFile()
        || !pathAfter.isFile()
        || !stableMetadata(before, after)
        || !stableMetadata(after, pathAfter)
      ) {
        throw gateViewError(code, root, relativePath, "changed-gate-member");
      }
      contentsByPath.set(normalizeArtifactPath(relativePath), content);
    } finally {
      await file.close();
    }
  }

  async function collectDirectory(
    path: string,
    relativePath: string,
    pathStat: BigIntStats,
  ): Promise<void> {
    let directory: FileHandle;
    try {
      directory = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      throw gateViewError(
        code,
        root,
        relativePath,
        errorCode(error) === "ELOOP" ? "symbolic-link" : "gate-view-io-error",
        error,
      );
    }

    try {
      const before = await directory.stat({ bigint: true });
      if (!before.isDirectory() || !sameIdentity(pathStat, before)) {
        throw gateViewError(code, root, relativePath, "unsafe-gate-member");
      }

      const entries = await readdir(path, { withFileTypes: true });
      entries.sort((left, right) => compareStrings(left.name, right.name));
      for (const entry of entries) {
        const childRelativePath = relativePath === "" ? entry.name : `${relativePath}/${entry.name}`;
        await collect(join(path, entry.name), childRelativePath);
      }

      const [after, pathAfter] = await Promise.all([
        directory.stat({ bigint: true }),
        lstat(path, { bigint: true }),
      ]);
      if (
        !after.isDirectory()
        || !pathAfter.isDirectory()
        || !stableMetadata(before, after)
        || !stableMetadata(after, pathAfter)
      ) {
        throw gateViewError(code, root, relativePath, "changed-gate-member");
      }
    } finally {
      await directory.close();
    }
  }

  async function collect(path: string, relativePath: string): Promise<void> {
    const stat = await lstat(path, { bigint: true });
    if (stat.isSymbolicLink()) {
      throw gateViewError(code, root, relativePath, "symbolic-link");
    }
    if (stat.isDirectory()) {
      await collectDirectory(path, relativePath, stat);
      return;
    }
    if (!stat.isFile()) {
      throw gateViewError(code, root, relativePath, "unsafe-gate-member");
    }
    await collectFile(path, relativePath, stat);
  }

  try {
    await collect(root, "");
    return { contentsByPath };
  } catch (error) {
    if (isAdmissionError(error)) {
      throw error;
    }
    const missingReason = code === "INVALID_PROCEDURE_GRAPH"
      ? "missing-skills-view"
      : "missing-agents-view";
    throw gateViewError(code, root, "", missingReason, error);
  }
}

export function assertPackageGateTargets(
  packageId: string,
  kind: PackageRecord["kind"],
  files: readonly { readonly target: string }[],
): void {
  for (const mapping of files) {
    const target = normalizeArtifactPath(mapping.target);
    if (target.startsWith("agents/") && kind !== "agent") {
      throw new CipherpolAdmissionError(
        "INVALID_AGENT_CONTEXT",
        `Only agent packages may target the checked flat agents view: ${target}`,
        { packageId, packageKind: kind, target, reason: "package-kind-mismatch" },
      );
    }
    if (target.startsWith("skills/") && kind !== "skill" && kind !== "procedure") {
      throw new CipherpolAdmissionError(
        "INVALID_PROCEDURE_GRAPH",
        `Only skill or procedure packages may target the checked flat skills view: ${target}`,
        { packageId, packageKind: kind, target, reason: "package-kind-mismatch" },
      );
    }
  }
}

function validateGateMembership(
  packageRecord: PackageRecord,
  artifact: CollectedArtifact,
  skillsView: CollectedGateView,
  agentsView: CollectedGateView,
): void {
  assertPackageGateTargets(packageRecord.id, packageRecord.kind, packageRecord.files);

  let prefix: "agents/" | "skills/";
  let code: GateErrorCode;
  let gateContents: ReadonlyMap<string, Buffer>;
  if (packageRecord.kind === "agent") {
    prefix = "agents/";
    code = "INVALID_AGENT_CONTEXT";
    gateContents = agentsView.contentsByPath;
  } else if (packageRecord.kind === "skill" || packageRecord.kind === "procedure") {
    prefix = "skills/";
    code = "INVALID_PROCEDURE_GRAPH";
    gateContents = skillsView.contentsByPath;
  } else {
    return;
  }

  if (packageRecord.files.length === 0) {
    throw new CipherpolAdmissionError(
      code,
      `Admitted ${packageRecord.kind} has no member in its checked flat view`,
      { packageId: packageRecord.id, reason: "missing-gate-member" },
    );
  }

  for (const mapping of packageRecord.files) {
    const source = normalizeArtifactPath(mapping.source);
    const target = normalizeArtifactPath(mapping.target);
    if (!target.startsWith(prefix) || target.length === prefix.length) {
      throw new CipherpolAdmissionError(
        code,
        `Admitted ${packageRecord.kind} target is outside its checked flat view: ${target}`,
        {
          packageId: packageRecord.id,
          source,
          target,
          expectedRoot: prefix.slice(0, -1),
          reason: "unexpected-gate-root",
        },
      );
    }

    const gateContent = gateContents.get(target.slice(prefix.length));
    if (gateContent === undefined) {
      throw new CipherpolAdmissionError(
        code,
        `Admitted package target is absent from its checked flat view: ${target}`,
        { source, target, reason: "missing-gate-member" },
      );
    }
    const artifactContent = artifact.contentsByPath.get(source);
    if (artifactContent === undefined || !gateContent.equals(artifactContent)) {
      throw new CipherpolAdmissionError(
        code,
        `Admitted package target differs from its checked flat view: ${target}`,
        { source, target, reason: "gate-content-mismatch" },
      );
    }
  }
}

function normalizeProvenance(provenance: PackageProvenance): PackageAdmissionEnvelope["provenance"] {
  const parsed = parseOrAdmissionError(provenanceSchema, provenance, "package provenance");
  return {
    sourceRepository: parsed.sourceRepository,
    sourceRevision: parsed.sourceRevision,
    sourcePaths: [...new Set(parsed.sourcePaths.map(normalizeArtifactPath))].sort(),
  };
}

function signingPayload(
  fields: Pick<
    PackageAdmissionEnvelope,
    "schemaVersion" | "packageRecord" | "provenance" | "keyId" | "algorithm" | "keyPurpose"
  >,
): Buffer {
  return Buffer.from(canonicalJson(fields), "utf8");
}

function assertPrivateEd25519Key(key: unknown): asserts key is KeyObject {
  if (!(key instanceof KeyObject) || key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new CipherpolAdmissionError(
      "INVALID_ADMISSION",
      "Signing key must be a private Ed25519 key",
    );
  }
}

function assertPublicEd25519Key(key: unknown): asserts key is KeyObject {
  if (!(key instanceof KeyObject) || key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new CipherpolAdmissionError(
      "UNTRUSTED_KEY",
      "Trusted key must be a public Ed25519 key",
    );
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string" ? error.code : undefined;
}

function assertValidCompatibility(input: Pick<PackageAdmissionInput, "compatibility">): void {
  const claudeCode = input.compatibility?.claudeCode;
  if (typeof claudeCode !== "string" || validRange(claudeCode) === null) {
    throw new CipherpolAdmissionError(
      "INVALID_ADMISSION",
      "Claude Code compatibility must be a valid semantic-version range",
      { field: "compatibility.claudeCode" },
    );
  }
}

function assertAdmissionGates(input: PackageAdmissionInput, gates: AdmissionGateInputs): void {
  if (
    gates === null
    || typeof gates !== "object"
    || !Array.isArray(gates.packageSet)
    || typeof gates.skillsDirectory !== "string"
    || typeof gates.agentsDirectory !== "string"
  ) {
    throw new CipherpolAdmissionError(
      "INVALID_ADMISSION",
      "Admission requires package-set, skills, and agents gate inputs",
    );
  }

  const packageSetIsValid = gates.packageSet.every((node: unknown) => (
    typeof node === "object"
    && node !== null
    && "id" in node
    && typeof node.id === "string"
    && node.id.length > 0
    && "dependencies" in node
    && Array.isArray(node.dependencies)
    && node.dependencies.every((dependency: unknown) => typeof dependency === "string")
  ));
  if (!packageSetIsValid) {
    throw new CipherpolAdmissionError(
      "INVALID_ADMISSION",
      "Admission package set contains an invalid dependency node",
    );
  }

  validateDependencyGraph(gates.packageSet);
  const admittedNode = gates.packageSet.find((node) => node.id === input.id);
  if (admittedNode === undefined) {
    throw new CipherpolAdmissionError(
      "INVALID_ADMISSION",
      "Admitted package is absent from the supplied package set",
      { packageId: input.id },
    );
  }
  const declaredDependencies = Array.isArray(input.dependencies)
    ? [...input.dependencies].sort(compareStrings)
    : [];
  const gatedDependencies = [...admittedNode.dependencies].sort(compareStrings);
  if (
    declaredDependencies.length !== gatedDependencies.length
    || declaredDependencies.some((dependency, index) => dependency !== gatedDependencies[index])
  ) {
    throw new CipherpolAdmissionError(
      "INVALID_ADMISSION",
      "Admitted package dependencies do not match the supplied package set",
      { packageId: input.id },
    );
  }

}

interface PreparedPackage {
  readonly packageRecord: PackageRecord;
  readonly provenance: PackageAdmissionEnvelope["provenance"];
}

async function collectAndValidateGateViews(
  skillsDirectory: string,
  agentsDirectory: string,
): Promise<{ skillsView: CollectedGateView; agentsView: CollectedGateView }> {
  const [skillsView, agentsView] = await Promise.all([
    collectGateView(skillsDirectory, "INVALID_PROCEDURE_GRAPH"),
    collectGateView(agentsDirectory, "INVALID_AGENT_CONTEXT"),
  ]);
  const procedureReport = checkProceduresFromFiles(skillsView.contentsByPath, skillsDirectory);
  if (procedureReport.skillCount === 0) {
    throw new CipherpolAdmissionError(
      "INVALID_PROCEDURE_GRAPH",
      "Admission requires a nonempty flat skills view",
      { skillsDirectory },
    );
  }
  const agentReport = checkAgentContextFromFiles(agentsView.contentsByPath, agentsDirectory);
  if (agentReport.agentFileCount === 0) {
    throw new CipherpolAdmissionError(
      "INVALID_AGENT_CONTEXT",
      "Admission requires a nonempty flat agents view",
      { agentsDirectory },
    );
  }
  return { skillsView, agentsView };
}

/**
 * Collects one package's artifact, parses and validates its package record against the
 * already-collected, already-reported skills/agents gate snapshot, and binds it to that
 * snapshot byte-for-byte. Shared by single-package and batch admission so a 152-package
 * batch collects each artifact exactly once against one shared snapshot.
 */
async function prepareAdmittedPackage(
  input: Omit<PackageAdmissionInput, "signingKey" | "keyId" | "keyPurpose">,
  artifactRoot: string,
  skillsView: CollectedGateView,
  agentsView: CollectedGateView,
): Promise<PreparedPackage> {
  assertPackageGateTargets(input.id, input.kind, input.files);

  const provenance = normalizeProvenance(input.provenance);
  if (provenance.sourceRevision !== input.sourceRevision) {
    throw new CipherpolAdmissionError(
      "PROVENANCE_MISMATCH",
      "Provenance revision does not match package source revision",
      { packageRevision: input.sourceRevision, provenanceRevision: provenance.sourceRevision },
    );
  }

  const artifact = await collectArtifact(artifactRoot);
  const packageRecord = parseOrAdmissionError(
    admittedPackageRecordSchema,
    {
      id: input.id,
      kind: input.kind,
      version: input.version,
      digest: artifact.digest,
      owner: input.owner,
      sourceRevision: input.sourceRevision,
      artifactPath: input.artifactPath,
      compatibility: input.compatibility,
      dependencies: input.dependencies,
      files: input.files,
      revoked: false,
    },
    "package record",
  );
  validateDeclaredFiles(packageRecord, artifact.regularFiles);
  validateGateMembership(packageRecord, artifact, skillsView, agentsView);

  return { packageRecord, provenance };
}

function signAdmissionEnvelope(
  packageRecord: PackageRecord,
  provenance: PackageAdmissionEnvelope["provenance"],
  signingKey: KeyObject,
  keyId: string,
  keyPurpose: "fixture" | "production",
): PackageAdmissionEnvelope {
  const signedFields = {
    schemaVersion: ADMISSION_SCHEMA_VERSION,
    packageRecord,
    provenance,
    keyId,
    algorithm: SIGNATURE_ALGORITHM,
    keyPurpose,
  } as const;

  let signature: string;
  try {
    signature = sign(null, signingPayload(signedFields), signingKey).toString("base64");
  } catch (error) {
    throw new CipherpolAdmissionError(
      "INVALID_ADMISSION",
      "Failed to sign package admission",
      error instanceof Error ? { causeName: error.name } : {},
    );
  }

  return { ...signedFields, signature };
}

export async function admitPackage(
  input: PackageAdmissionInput,
  artifactRoot: string,
  gates: AdmissionGateInputs,
): Promise<PackageAdmissionEnvelope> {
  assertPrivateEd25519Key(input.signingKey);
  assertValidCompatibility(input);
  assertAdmissionGates(input, gates);

  const { skillsView, agentsView } = await collectAndValidateGateViews(
    gates.skillsDirectory,
    gates.agentsDirectory,
  );
  const { packageRecord, provenance } = await prepareAdmittedPackage(
    input,
    artifactRoot,
    skillsView,
    agentsView,
  );

  const keyId = parseOrAdmissionError(keyIdSchema, input.keyId, "signing key ID");
  const keyPurpose = parseOrAdmissionError(keyPurposeSchema, input.keyPurpose, "signing key purpose");
  return signAdmissionEnvelope(packageRecord, provenance, input.signingKey, keyId, keyPurpose);
}

export async function verifyAdmission(
  admission: unknown,
  options: AdmissionVerificationOptions,
): Promise<AdmissionVerificationResult> {
  const envelope = parseOrAdmissionError(admissionEnvelopeSchema, admission, "package admission envelope");
  if (envelope.keyPurpose === "fixture" && !options.allowFixtureKeys) {
    throw new CipherpolAdmissionError(
      "UNTRUSTED_KEY",
      "Fixture-purpose admission keys are not trusted unless explicitly allowed",
      { keyPurpose: envelope.keyPurpose },
    );
  }
  if (envelope.keyId !== options.trustedKeyId) {
    throw new CipherpolAdmissionError(
      "UNTRUSTED_KEY",
      "Admission key ID is not trusted",
      { keyId: envelope.keyId },
    );
  }
  assertPublicEd25519Key(options.trustedPublicKey);

  let signatureValid: boolean;
  try {
    signatureValid = verify(
      null,
      signingPayload({
        schemaVersion: envelope.schemaVersion,
        packageRecord: envelope.packageRecord,
        provenance: envelope.provenance,
        keyId: envelope.keyId,
        algorithm: envelope.algorithm,
        keyPurpose: envelope.keyPurpose,
      }),
      options.trustedPublicKey,
      Buffer.from(envelope.signature, "base64"),
    );
  } catch (error) {
    throw new CipherpolAdmissionError(
      "SIGNATURE_INVALID",
      "Admission signature verification failed",
      error instanceof Error ? { causeName: error.name } : {},
    );
  }
  if (!signatureValid) {
    throw new CipherpolAdmissionError("SIGNATURE_INVALID", "Admission signature is invalid");
  }

  const normalizedProvenance = normalizeProvenance(envelope.provenance);
  const pathsAreCanonical = normalizedProvenance.sourcePaths.length === envelope.provenance.sourcePaths.length
    && normalizedProvenance.sourcePaths.every(
      (sourcePath, index) => sourcePath === envelope.provenance.sourcePaths[index],
    );
  if (envelope.provenance.sourceRevision !== envelope.packageRecord.sourceRevision || !pathsAreCanonical) {
    throw new CipherpolAdmissionError(
      "PROVENANCE_MISMATCH",
      "Admission provenance is not canonically bound to the package record",
      {
        packageRevision: envelope.packageRecord.sourceRevision,
        provenanceRevision: envelope.provenance.sourceRevision,
      },
    );
  }

  if (options.artifactRoot !== undefined) {
    const artifact = await collectArtifact(options.artifactRoot);
    validateDeclaredFiles(envelope.packageRecord, artifact.regularFiles);
    if (artifact.digest !== envelope.packageRecord.digest) {
      throw new CipherpolAdmissionError(
        "DIGEST_MISMATCH",
        "Artifact digest does not match admitted package",
        { expected: envelope.packageRecord.digest, actual: artifact.digest },
      );
    }
  }

  return {
    valid: true,
    packageRecord: envelope.packageRecord,
    provenance: envelope.provenance,
    keyId: envelope.keyId,
  };
}

/**
 * Admits a complete set of generated package inputs as one gated batch: the full
 * dependency graph is validated once, one shared skills/agents gate snapshot is
 * collected and reported once, each package's artifact is collected exactly once
 * against that shared snapshot, and every envelope is signed deterministically in
 * package-ID order. No envelope is signed if any package fails any check.
 */
export async function admitPackageSet(args: {
  readonly packages: readonly GeneratedPackageInput[];
  readonly materialized: MaterializedClosure;
  readonly signingKey: KeyObject;
  readonly keyId: string;
  readonly keyPurpose: "fixture" | "production";
}): Promise<readonly PackageAdmissionEnvelope[]> {
  const { packages, materialized, signingKey, keyId, keyPurpose } = args;
  assertPrivateEd25519Key(signingKey);
  const parsedKeyId = parseOrAdmissionError(keyIdSchema, keyId, "signing key ID");
  const parsedKeyPurpose = parseOrAdmissionError(keyPurposeSchema, keyPurpose, "signing key purpose");

  if (packages.length === 0) {
    throw new CipherpolAdmissionError(
      "INVALID_ADMISSION",
      "Batch admission requires at least one package",
    );
  }

  for (const { input } of packages) {
    assertValidCompatibility(input);
  }
  const packageSet: PackageDependencyNode[] = packages.map(({ input }) => ({
    id: input.id,
    dependencies: Array.isArray(input.dependencies) ? [...input.dependencies] : [],
  }));
  validateDependencyGraph(packageSet);

  const { skillsView, agentsView } = await collectAndValidateGateViews(
    materialized.skillsDirectory,
    materialized.agentsDirectory,
  );

  const ordered = [...packages].sort((left, right) => compareStrings(left.input.id, right.input.id));
  const prepared: PreparedPackage[] = [];
  for (const { input, artifactRoot } of ordered) {
    prepared.push(await prepareAdmittedPackage(input, artifactRoot, skillsView, agentsView));
  }

  return prepared.map(({ packageRecord, provenance }) => (
    signAdmissionEnvelope(packageRecord, provenance, signingKey, parsedKeyId, parsedKeyPurpose)
  ));
}
