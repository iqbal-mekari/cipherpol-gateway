#!/usr/bin/env node
import { createPrivateKey, createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalJson, type ClosureManifest, type PackageRecord, type RegistryEnvelope } from "@cipherpol/contracts";
import { stringify } from "yaml";
import {
  admitPackage,
  admitPackageSet,
  type AdmissionGateInputs,
  type PackageAdmissionInput,
  verifyAdmission,
} from "./admission.js";
import { composeClosureManifest, composeClosureRegistry } from "./closure.js";
import { CipherpolAdmissionError } from "./errors.js";
import { loadImportPolicy } from "./import-policy.js";
import { importSoftwareDevAgenticArtifacts, measureSoftwareDevAgenticCorpus } from "./importer.js";
import { materializeClosure } from "./materialize.js";
import { generatePackageInputs } from "./package-records.js";
import { compareClosureTrees } from "./reproducibility.js";
import { signRegistryEnvelope, verifyRegistryEnvelope } from "./registry-signing.js";

/**
 * The only key ID ever trusted for `--fixture` operations. Binding `--fixture` to
 * this exact literal — rather than trusting whatever key ID the caller supplies —
 * prevents an arbitrary key from being signed or verified as fixture-purpose, and
 * prevents this specific fixture key from ever being accepted as a production key.
 */
const APPROVED_FIXTURE_KEY_ID = "fixture.stage2.software-dev-agentic";

/**
 * A fixed logical identifier for the imported corpus, independent of wherever
 * `--source-root` happens to be checked out. Signed provenance must never contain
 * a machine-specific absolute path, and two clean-room builds of the same corpus
 * must record identical provenance regardless of their local checkout location.
 */
const CLOSURE_SOURCE_REPOSITORY = "software-dev-agentic";

const USAGE = [
  "Usage:",
  "  cipherpol-admission import --source-root <path> --source-revision <revision> --output <path> [--force]",
  "  cipherpol-admission admit --metadata <json-path> --artifact-root <path> --package-set <json-path> --skills-directory <path> --agents-directory <path> --private-key <pem-path> --key-id <id> --output <path> [--fixture] [--force]",
  "  cipherpol-admission verify --envelope <json-path> --public-key <pem-path> --key-id <id> [--fixture] [--artifact-root <path>]",
  "  cipherpol-admission close --source-root <path> --source-revision <revision> --policy <yaml-path> --private-key <pem-path> --key-id <id> --output <path> [--fixture] [--force]",
  "  cipherpol-admission verify-closure --registry-root <path> --public-key <pem-path> --key-id <id> [--fixture] [--verify-artifacts]",
].join("\n");

class CliInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CliInputError";
  }
}

interface ParsedOptions {
  readonly values: ReadonlyMap<string, string>;
  readonly force: boolean;
}

function parseOptions(
  args: readonly string[],
  valueFlags: readonly string[],
  allowForce: boolean,
): ParsedOptions {
  const values = new Map<string, string>();
  let force = false;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--force" && allowForce) {
      if (force) throw new CliInputError("USAGE", "--force may be specified only once");
      force = true;
      continue;
    }
    if (flag === undefined || !valueFlags.includes(flag)) {
      throw new CliInputError("USAGE", `Unknown option: ${flag ?? "<missing>"}`);
    }
    if (values.has(flag)) throw new CliInputError("USAGE", `${flag} may be specified only once`);
    const optionValue = args[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw new CliInputError("USAGE", `${flag} requires a value`);
    }
    values.set(flag, optionValue);
    index += 1;
  }

  return { values, force };
}

function required(options: ParsedOptions, flag: string): string {
  const optionValue = options.values.get(flag);
  if (optionValue === undefined) throw new CliInputError("USAGE", `${flag} is required`);
  return optionValue;
}

interface ParsedClosureOptions {
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

function parseClosureOptions(
  args: readonly string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[],
): ParsedClosureOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== undefined && booleanFlags.includes(flag)) {
      if (flags.has(flag)) throw new CliInputError("USAGE", `${flag} may be specified only once`);
      flags.add(flag);
      continue;
    }
    if (flag === undefined || !valueFlags.includes(flag)) {
      throw new CliInputError("USAGE", `Unknown option: ${flag ?? "<missing>"}`);
    }
    if (values.has(flag)) throw new CliInputError("USAGE", `${flag} may be specified only once`);
    const optionValue = args[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw new CliInputError("USAGE", `${flag} requires a value`);
    }
    values.set(flag, optionValue);
    index += 1;
  }

  return { values, flags };
}

function requiredValue(options: ParsedClosureOptions, flag: string): string {
  const optionValue = options.values.get(flag);
  if (optionValue === undefined) throw new CliInputError("USAGE", `${flag} is required`);
  return optionValue;
}

async function readTextFile(path: string, label: string): Promise<string> {
  try {
    return await readFile(resolve(path), "utf8");
  } catch {
    throw new CliInputError("INPUT_READ_FAILED", `Unable to read ${label} file`);
  }
}

async function readJsonObject(path: string, label: string): Promise<Record<string, unknown>> {
  const contents = await readTextFile(path, label);
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new CliInputError("INVALID_JSON", `${label} file must contain valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliInputError("INVALID_JSON", `${label} file must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

async function removeStage(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function ensureOutputAvailable(path: string, force: boolean): Promise<void> {
  if (force) return;
  try {
    await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw new CliInputError("OUTPUT_CHECK_FAILED", "Unable to inspect output path");
  }
  throw new CliInputError("OUTPUT_EXISTS", "Output already exists; pass --force to replace it");
}

async function writeAtomically(path: string, contents: string, force: boolean): Promise<void> {
  const outputPath = resolve(path);
  await ensureOutputAvailable(outputPath, force);
  const stagePath = join(dirname(outputPath), `.${basename(outputPath)}.${process.pid}.${randomUUID()}.stage`);

  try {
    const stage = await open(stagePath, "wx", 0o600);
    try {
      await stage.writeFile(contents, "utf8");
      await stage.sync();
    } finally {
      await stage.close();
    }
  } catch {
    try {
      await removeStage(stagePath);
    } catch {
      // The primary staging failure remains the stable user-facing error.
    }
    throw new CliInputError("OUTPUT_WRITE_FAILED", "Unable to stage output file");
  }

  try {
    if (force) {
      await rename(stagePath, outputPath);
      return;
    }
    await link(stagePath, outputPath);
  } catch (error) {
    try {
      await removeStage(stagePath);
    } catch {
      // The primary publish failure remains the stable user-facing error.
    }
    if (!force && errorCode(error) === "EEXIST") {
      throw new CliInputError("OUTPUT_EXISTS", "Output already exists; pass --force to replace it");
    }
    throw new CliInputError("OUTPUT_WRITE_FAILED", "Unable to publish output file");
  }

  try {
    await unlink(stagePath);
  } catch {
    // Publication succeeded; a stale sibling stage file does not invalidate the output.
  }
}

function asPrettyCanonicalJson(value: unknown): string {
  const canonicalValue: unknown = JSON.parse(canonicalJson(value));
  return `${JSON.stringify(canonicalValue, null, 2)}\n`;
}

async function importCommand(args: readonly string[]): Promise<void> {
  const options = parseOptions(args, ["--source-root", "--source-revision", "--output"], true);
  const sourceRoot = required(options, "--source-root");
  const sourceRevision = required(options, "--source-revision");
  const outputPath = resolve(required(options, "--output"));
  await ensureOutputAvailable(outputPath, options.force);

  const result = await measureSoftwareDevAgenticCorpus({
    repositoryRoot: sourceRoot,
    sourceRevision,
  });
  const yaml = stringify(result.manifest, { sortMapEntries: true });
  await writeAtomically(outputPath, yaml, options.force);

  const counts = result.measured;
  console.log([
    "imported",
    `userFacing=${counts.userFacing}`,
    `skills=${counts.skills}`,
    `agents=${counts.agents}`,
    `references=${counts.references}`,
    `cp1Tools=${counts.cp1Tools}`,
    `classifiedEntries=${counts.classifiedEntries}`,
    `taxonomies=${counts.taxonomies}`,
    `output=${outputPath}`,
  ].join(" "));
}

async function admitCommand(args: readonly string[]): Promise<void> {
  const options = parseClosureOptions(
    args,
    [
      "--metadata",
      "--artifact-root",
      "--package-set",
      "--skills-directory",
      "--agents-directory",
      "--private-key",
      "--key-id",
      "--output",
    ],
    ["--fixture", "--force"],
  );
  const metadataPath = requiredValue(options, "--metadata");
  const artifactRoot = requiredValue(options, "--artifact-root");
  const packageSetPath = requiredValue(options, "--package-set");
  const skillsDirectory = requiredValue(options, "--skills-directory");
  const agentsDirectory = requiredValue(options, "--agents-directory");
  const privateKeyPath = requiredValue(options, "--private-key");
  const keyId = requiredValue(options, "--key-id");
  const outputPath = resolve(requiredValue(options, "--output"));
  const fixture = options.flags.has("--fixture");
  const force = options.flags.has("--force");

  if (fixture !== (keyId === APPROVED_FIXTURE_KEY_ID)) {
    throw new CliInputError(
      "UNTRUSTED_KEY",
      fixture
        ? "The --fixture flag requires the approved fixture key ID"
        : "The approved fixture key ID requires the --fixture flag",
    );
  }
  await ensureOutputAvailable(outputPath, force);

  const [metadata, packageSetDocument, privateKeyPem] = await Promise.all([
    readJsonObject(metadataPath, "metadata"),
    readJsonObject(packageSetPath, "package set"),
    readTextFile(privateKeyPath, "private key"),
  ]);
  const packageSet = packageSetDocument["packages"];
  if (!Array.isArray(packageSet)) {
    throw new CliInputError("INVALID_JSON", "package set file must contain a packages array");
  }
  let signingKey: KeyObject;
  try {
    signingKey = createPrivateKey(privateKeyPem);
  } catch {
    throw new CliInputError("INVALID_PRIVATE_KEY", "Private key file must contain a valid PEM private key");
  }

  const keyPurpose: "fixture" | "production" = fixture ? "fixture" : "production";
  const envelope = await admitPackage({
    ...metadata,
    signingKey,
    keyId,
    keyPurpose,
  } as PackageAdmissionInput, artifactRoot, {
    packageSet,
    skillsDirectory,
    agentsDirectory,
  } as AdmissionGateInputs);
  await writeAtomically(outputPath, asPrettyCanonicalJson(envelope), force);
  console.log([
    "admitted",
    `id=${envelope.packageRecord.id}`,
    `digest=${envelope.packageRecord.digest}`,
    `keyId=${envelope.keyId}`,
    `output=${outputPath}`,
  ].join(" "));
}

async function verifyCommand(args: readonly string[]): Promise<void> {
  const options = parseClosureOptions(
    args,
    ["--envelope", "--public-key", "--key-id", "--artifact-root"],
    ["--fixture"],
  );
  const envelope = await readJsonObject(requiredValue(options, "--envelope"), "envelope");
  const publicKeyPem = await readTextFile(requiredValue(options, "--public-key"), "public key");
  const trustedKeyId = requiredValue(options, "--key-id");
  const fixture = options.flags.has("--fixture");

  if (fixture !== (trustedKeyId === APPROVED_FIXTURE_KEY_ID)) {
    throw new CliInputError(
      "UNTRUSTED_KEY",
      fixture
        ? "The --fixture flag requires the approved fixture key ID"
        : "The approved fixture key ID requires the --fixture flag",
    );
  }

  let trustedPublicKey: KeyObject;
  try {
    trustedPublicKey = createPublicKey(publicKeyPem);
  } catch {
    throw new CliInputError("INVALID_PUBLIC_KEY", "Public key file must contain a valid PEM public key");
  }

  const artifactRoot = options.values.get("--artifact-root");
  const result = await verifyAdmission(envelope, {
    trustedKeyId,
    trustedPublicKey,
    allowFixtureKeys: fixture,
    ...(artifactRoot === undefined ? {} : { artifactRoot }),
  });
  console.log([
    "verified",
    `id=${result.packageRecord.id}`,
    `digest=${result.packageRecord.digest}`,
    `keyId=${result.keyId}`,
  ].join(" "));
}

interface ClosureAttemptResult {
  readonly publishRoot: string;
  readonly registryEnvelope: RegistryEnvelope;
  readonly closureManifest: ClosureManifest;
  readonly packageCount: number;
}

/**
 * Runs the complete import -> materialize -> admit -> compose -> sign pipeline once
 * into a fresh attempt root, then relocates the result into a `publish` subdirectory
 * containing only `artifacts/`, `admissions/`, and `registry-envelope.json` — the
 * exact shape published to `--output`. The ephemeral `.gates` scanning view used by
 * batch admission is left behind under `attemptRoot` and never published.
 *
 * Uses the raw {@link importSoftwareDevAgenticArtifacts} scan rather than
 * {@link measureSoftwareDevAgenticCorpus}: the latter's baseline check is hardcoded
 * to the real shipping corpus's exact counts and would reject every other source
 * tree outright, making this command unusable against a portable fixture corpus.
 * The universal invariants that do apply to every closure — schema-valid mappings
 * and exactly 17 distinct MCP capabilities — are still enforced unconditionally by
 * `closureManifestSchema` inside {@link composeClosureManifest}.
 */
async function buildClosureAttempt(args: {
  readonly sourceRoot: string;
  readonly sourceRevision: string;
  readonly policyPath: string;
  readonly signingKey: KeyObject;
  readonly keyId: string;
  readonly keyPurpose: "fixture" | "production";
  readonly attemptRoot: string;
}): Promise<ClosureAttemptResult> {
  const { sourceRoot, sourceRevision, policyPath, signingKey, keyId, keyPurpose, attemptRoot } = args;

  const [imported, policy] = await Promise.all([
    importSoftwareDevAgenticArtifacts({ repositoryRoot: sourceRoot, sourceRevision }),
    loadImportPolicy(policyPath),
  ]);
  const materializeRoot = join(attemptRoot, "materialize");
  const materialized = await materializeClosure({ sourceRoot, outputRoot: materializeRoot, imported });
  const generated = generatePackageInputs({
    imported,
    materialized,
    policy,
    sourceRepository: CLOSURE_SOURCE_REPOSITORY,
  });
  const envelopes = await admitPackageSet({ packages: generated, materialized, signingKey, keyId, keyPurpose });
  const closureManifest = composeClosureManifest({
    parity: imported.manifest,
    admissions: envelopes,
    descriptors: imported.artifacts,
    admissionsRoot: "admissions",
  });
  const registryIndex = composeClosureRegistry({ admissions: envelopes, closure: closureManifest });
  const registryEnvelope = signRegistryEnvelope(registryIndex, closureManifest, {
    keyId,
    keyPurpose,
    privateKey: signingKey,
  });

  const publishRoot = join(attemptRoot, "publish");
  await mkdir(publishRoot, { recursive: true, mode: 0o755 });
  await rename(join(materializeRoot, "artifacts"), join(publishRoot, "artifacts"));

  const admissionByPackageId = new Map(envelopes.map((admitted) => [admitted.packageRecord.id, admitted] as const));
  const publishedAdmissionPaths = new Set<string>();
  for (const mapping of closureManifest.mappings) {
    if (publishedAdmissionPaths.has(mapping.admissionPath)) continue;
    const envelope = admissionByPackageId.get(mapping.packageId);
    if (envelope === undefined) {
      throw new CipherpolAdmissionError(
        "UNKNOWN_PACKAGE_REFERENCE",
        `Closure mapping references a package with no admission envelope: ${mapping.packageId}`,
        { packageId: mapping.packageId },
      );
    }
    const admissionFilePath = join(publishRoot, ...mapping.admissionPath.split("/"));
    await mkdir(dirname(admissionFilePath), { recursive: true, mode: 0o755 });
    await writeFile(admissionFilePath, asPrettyCanonicalJson(envelope), { mode: 0o644 });
    await chmod(admissionFilePath, 0o644);
    publishedAdmissionPaths.add(mapping.admissionPath);
  }

  const registryEnvelopePath = join(publishRoot, "registry-envelope.json");
  await writeFile(registryEnvelopePath, asPrettyCanonicalJson(registryEnvelope), { mode: 0o644 });
  await chmod(registryEnvelopePath, 0o644);

  return { publishRoot, registryEnvelope, closureManifest, packageCount: envelopes.length };
}

async function closeCommand(args: readonly string[]): Promise<void> {
  const options = parseClosureOptions(
    args,
    ["--source-root", "--source-revision", "--policy", "--private-key", "--key-id", "--output"],
    ["--fixture", "--force"],
  );
  const sourceRoot = requiredValue(options, "--source-root");
  const sourceRevision = requiredValue(options, "--source-revision");
  const policyPath = requiredValue(options, "--policy");
  const privateKeyPath = requiredValue(options, "--private-key");
  const keyId = requiredValue(options, "--key-id");
  const outputPath = resolve(requiredValue(options, "--output"));
  const fixture = options.flags.has("--fixture");
  const force = options.flags.has("--force");

  if (fixture !== (keyId === APPROVED_FIXTURE_KEY_ID)) {
    throw new CliInputError(
      "UNTRUSTED_KEY",
      fixture
        ? "The --fixture flag requires the approved fixture key ID"
        : "The approved fixture key ID requires the --fixture flag",
    );
  }

  await ensureOutputAvailable(outputPath, force);

  const privateKeyPem = await readTextFile(privateKeyPath, "private key");
  let signingKey: KeyObject;
  try {
    signingKey = createPrivateKey(privateKeyPem);
  } catch {
    throw new CliInputError("INVALID_PRIVATE_KEY", "Private key file must contain a valid PEM private key");
  }

  const keyPurpose: "fixture" | "production" = fixture ? "fixture" : "production";
  const outputParent = dirname(outputPath);
  const attemptSuffix = `${process.pid}.${randomUUID()}`;
  const attemptA = join(outputParent, `.${basename(outputPath)}.stage2-closure.${attemptSuffix}.a`);
  const attemptB = join(outputParent, `.${basename(outputPath)}.stage2-closure.${attemptSuffix}.b`);

  try {
    const first = await buildClosureAttempt({
      sourceRoot,
      sourceRevision,
      policyPath,
      signingKey,
      keyId,
      keyPurpose,
      attemptRoot: attemptA,
    });
    const second = await buildClosureAttempt({
      sourceRoot,
      sourceRevision,
      policyPath,
      signingKey,
      keyId,
      keyPurpose,
      attemptRoot: attemptB,
    });

    await compareClosureTrees(first.publishRoot, second.publishRoot);

    const publicKey = createPublicKey(signingKey);
    verifyRegistryEnvelope({
      envelope: first.registryEnvelope,
      trustedKeyId: keyId,
      trustedKeyPurpose: keyPurpose,
      publicKey,
      allowFixtureKeys: fixture,
    });

    await ensureOutputAvailable(outputPath, force);
    if (force) {
      await rm(outputPath, { recursive: true, force: true });
    }
    try {
      await rename(first.publishRoot, outputPath);
    } catch {
      throw new CliInputError("OUTPUT_WRITE_FAILED", "Unable to publish closure output directory");
    }

    const mcpMappings = first.closureManifest.mappings.filter((mapping) => mapping.mappingType === "mcp-tool").length;
    console.log(`physical packages ${first.packageCount}`);
    console.log(`parity mappings ${first.closureManifest.mappings.length}`);
    console.log(`cp1 MCP mappings ${mcpMappings}`);
    console.log("clean-room comparison identical");
    console.log("registry signature verified");
  } finally {
    await Promise.all([
      rm(attemptA, { recursive: true, force: true }),
      rm(attemptB, { recursive: true, force: true }),
    ]);
  }
}

function readAdmissionArtifactPath(envelope: Record<string, unknown>, packageId: string): string {
  const packageRecord = envelope["packageRecord"];
  const artifactPath = packageRecord !== null && typeof packageRecord === "object" && !Array.isArray(packageRecord)
    ? (packageRecord as Record<string, unknown>)["artifactPath"]
    : undefined;
  if (typeof artifactPath !== "string" || artifactPath.length === 0) {
    throw new CliInputError(
      "INVALID_JSON",
      `Admission envelope for ${packageId} must declare a packageRecord.artifactPath`,
    );
  }
  return artifactPath;
}

async function assertDeclaredArtifactModes(artifactRoot: string, packageRecord: PackageRecord): Promise<void> {
  for (const file of packageRecord.files) {
    if (file.mode === undefined) continue;
    const filePath = join(artifactRoot, ...file.source.split("/"));
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new CipherpolAdmissionError(
        "UNSAFE_ARTIFACT_FILE",
        `Artifact file must be a regular file: ${file.source}`,
        { packageId: packageRecord.id, source: file.source },
      );
    }
    const actualMode = stats.mode & 0o777;
    if (actualMode !== file.mode) {
      throw new CipherpolAdmissionError(
        "MODE_MISMATCH",
        `Artifact file mode does not match the declared mode: ${file.source}`,
        { packageId: packageRecord.id, source: file.source, declaredMode: file.mode, actualMode },
      );
    }
  }
}

async function verifyClosureCommand(args: readonly string[]): Promise<void> {
  const options = parseClosureOptions(
    args,
    ["--registry-root", "--public-key", "--key-id"],
    ["--fixture", "--verify-artifacts"],
  );
  const registryRoot = resolve(requiredValue(options, "--registry-root"));
  const publicKeyPath = requiredValue(options, "--public-key");
  const trustedKeyId = requiredValue(options, "--key-id");
  const fixture = options.flags.has("--fixture");
  const verifyArtifacts = options.flags.has("--verify-artifacts");

  const publicKeyPem = await readTextFile(publicKeyPath, "public key");
  let trustedPublicKey: KeyObject;
  try {
    trustedPublicKey = createPublicKey(publicKeyPem);
  } catch {
    throw new CliInputError("INVALID_PUBLIC_KEY", "Public key file must contain a valid PEM public key");
  }

  const registryEnvelopeRaw = await readJsonObject(join(registryRoot, "registry-envelope.json"), "registry envelope");
  const keyPurpose: "fixture" | "production" = fixture ? "fixture" : "production";
  const registryEnvelope = verifyRegistryEnvelope({
    envelope: registryEnvelopeRaw,
    trustedKeyId,
    trustedKeyPurpose: keyPurpose,
    publicKey: trustedPublicKey,
    allowFixtureKeys: fixture,
  });

  const verifiedPackageIds = new Set<string>();
  for (const mapping of registryEnvelope.closureManifest.mappings) {
    if (verifiedPackageIds.has(mapping.packageId)) continue;
    const admissionEnvelopeRaw = await readJsonObject(
      join(registryRoot, ...mapping.admissionPath.split("/")),
      `admission envelope for ${mapping.packageId}`,
    );
    const artifactPath = verifyArtifacts
      ? readAdmissionArtifactPath(admissionEnvelopeRaw, mapping.packageId)
      : undefined;
    const result = await verifyAdmission(admissionEnvelopeRaw, {
      trustedKeyId,
      trustedPublicKey,
      allowFixtureKeys: fixture,
      ...(artifactPath === undefined ? {} : { artifactRoot: join(registryRoot, ...artifactPath.split("/")) }),
    });
    if (
      result.packageRecord.id !== mapping.packageId
      || result.packageRecord.version !== mapping.packageVersion
      || result.packageRecord.digest !== mapping.packageDigest
    ) {
      throw new CipherpolAdmissionError(
        "PROVENANCE_MISMATCH",
        `Admitted package record does not match its closure mapping: ${mapping.packageId}`,
        { packageId: mapping.packageId },
      );
    }
    if (verifyArtifacts) {
      await assertDeclaredArtifactModes(
        join(registryRoot, ...result.packageRecord.artifactPath.split("/")),
        result.packageRecord,
      );
    }
    verifiedPackageIds.add(mapping.packageId);
  }

  for (const record of registryEnvelope.registryIndex.packages) {
    if (!verifiedPackageIds.has(record.id)) {
      throw new CipherpolAdmissionError(
        "UNMAPPED_REGISTRY_PACKAGE",
        `Registry package has no verified closure mapping: ${record.id}`,
        { packageId: record.id },
      );
    }
  }

  const mcpMappings = registryEnvelope.closureManifest.mappings
    .filter((mapping) => mapping.mappingType === "mcp-tool").length;
  console.log(`physical packages ${verifiedPackageIds.size}`);
  console.log(`parity mappings ${registryEnvelope.closureManifest.mappings.length}`);
  console.log(`cp1 MCP mappings ${mcpMappings}`);
  console.log("registry signature verified");
}

async function main(args: readonly string[]): Promise<void> {
  const [command, ...options] = args;
  switch (command) {
    case "import":
      await importCommand(options);
      return;
    case "admit":
      await admitCommand(options);
      return;
    case "verify":
      await verifyCommand(options);
      return;
    case "close":
      await closeCommand(options);
      return;
    case "verify-closure":
      await verifyClosureCommand(options);
      return;
    default:
      throw new CliInputError("USAGE", USAGE);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof CliInputError || error instanceof CipherpolAdmissionError) {
    console.error(`${error.code}: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  console.error("INTERNAL_ERROR: Command failed");
  process.exitCode = 1;
});
