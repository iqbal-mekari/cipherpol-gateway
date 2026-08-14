import { constants, type Stats } from "node:fs";
import {
  glob,
  lstat,
  open,
  readdir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  parityEntryV2Schema,
  type PackageRecord,
  type ParityEntryV2,
  type ParityManifestV2,
} from "@cipherpol/contracts";
import { parseDocument } from "yaml";
import { CipherpolAdmissionError } from "./errors.js";
import {
  buildParityManifest,
  measureParityEntries,
  verifyParityBaseline,
  type MeasuredParityCounts,
} from "./parity.js";

export const SOFTWARE_DEV_AGENTIC_VERSIONS = {
  "cipherpol-aegis": "16.0.1",
  "cipherpol-9": "13.14.0",
  "cipherpol-1": "0.2.0",
} as const;

export type SoftwareDevAgenticModule = keyof typeof SOFTWARE_DEV_AGENTIC_VERSIONS;

const MODULES = Object.keys(SOFTWARE_DEV_AGENTIC_VERSIONS).sort() as SoftwareDevAgenticModule[];
const NAMESPACE_BY_MODULE: Record<SoftwareDevAgenticModule, string> = {
  "cipherpol-aegis": "cipherpol.aegis",
  "cipherpol-9": "cipherpol.9",
  "cipherpol-1": "cipherpol.1",
};
const EXPECTED_CP1_TOOL_COUNT = 17;

interface BuildConfig {
  name: SoftwareDevAgenticModule;
  mcpServer?: string;
  include: {
    agents: string[];
    skills: string[];
    reference: string[];
  };
}

interface MarketplacePlugin {
  name: string;
  version: string;
}

interface Frontmatter {
  name: string;
  description: string;
  userInvocable?: boolean;
  permissions: string[];
  relatedSkills: string[];
  agents: string[];
}

interface SelectedMarkdown {
  module: SoftwareDevAgenticModule;
  moduleVersion: string;
  sourcePath: string;
  targetPath: string;
  includePattern: string;
  selection: "agent" | "skill" | "reference";
}

interface EntryMetadata {
  body: string;
  relatedSkills: string[];
  agents: string[];
}

export interface ImportSoftwareDevAgenticOptions {
  repositoryRoot: string;
  sourceRevision: string;
}

export interface ImportedArtifactDescriptor {
  readonly packageId: string;
  readonly parityIds: readonly string[];
  readonly module: SoftwareDevAgenticModule;
  readonly moduleVersion: string;
  readonly packageKind: PackageRecord["kind"];
  readonly sourceKind: "directory" | "file" | "cp1-adapter";
  readonly sourcePaths: readonly string[];
  readonly targetRoot: string;
}

export interface SoftwareDevAgenticImportResult {
  sourceRevision: string;
  moduleVersions: Record<SoftwareDevAgenticModule, string>;
  entries: ParityEntryV2[];
  manifest: ParityManifestV2;
  measured: MeasuredParityCounts;
  readonly artifacts: readonly ImportedArtifactDescriptor[];
}

function provenanceFailure(message: string, details: Record<string, unknown> = {}): never {
  throw new CipherpolAdmissionError("PROVENANCE_MISMATCH", message, details);
}

function duplicateFailure(message: string, details: Record<string, unknown>): never {
  throw new CipherpolAdmissionError("DUPLICATE_PACKAGE_ID", message, details);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function canonicalRepositoryRoot(repositoryRoot: string): Promise<string> {
  const suppliedRoot = resolve(repositoryRoot);
  let initialStats: Stats;
  try {
    initialStats = await lstat(suppliedRoot);
  } catch (error) {
    return provenanceFailure("Repository root is missing or unreadable", {
      repositoryRoot: suppliedRoot,
      error: errorMessage(error),
    });
  }
  if (initialStats.isSymbolicLink()) {
    return provenanceFailure("Repository root must not be a symbolic link", {
      repositoryRoot: suppliedRoot,
    });
  }
  if (!initialStats.isDirectory()) {
    return provenanceFailure("Repository root is not a directory", {
      repositoryRoot: suppliedRoot,
    });
  }

  let canonicalRoot: string;
  let currentStats: Stats;
  try {
    canonicalRoot = await realpath(suppliedRoot);
    currentStats = await lstat(suppliedRoot);
  } catch (error) {
    return provenanceFailure("Repository root cannot be canonicalized", {
      repositoryRoot: suppliedRoot,
      error: errorMessage(error),
    });
  }
  if (
    currentStats.isSymbolicLink()
    || !currentStats.isDirectory()
    || currentStats.dev !== initialStats.dev
    || currentStats.ino !== initialStats.ino
  ) {
    return provenanceFailure("Repository root changed while canonicalizing", {
      repositoryRoot: suppliedRoot,
    });
  }
  return canonicalRoot;
}

interface VerifiedAuthoredPath {
  absolutePath: string;
  stats: Stats;
}

function pathIsWithinRoot(repositoryRoot: string, candidate: string): boolean {
  const sourcePath = relative(repositoryRoot, candidate);
  return sourcePath !== ".." && !sourcePath.startsWith(`..${sep}`) && !isAbsolute(sourcePath);
}

async function verifyAuthoredPath(
  repositoryRoot: string,
  candidate: string,
  label: string,
  kind: "file" | "directory",
  allowMissing = false,
): Promise<VerifiedAuthoredPath | undefined> {
  const absolutePath = resolve(candidate);
  if (!pathIsWithinRoot(repositoryRoot, absolutePath) || absolutePath === repositoryRoot) {
    return provenanceFailure("Authored source path escapes canonical repository root", {
      repositoryRoot,
      path: absolutePath,
      label,
    });
  }

  const sourcePath = relative(repositoryRoot, absolutePath);
  const segments = sourcePath.split(sep);
  let current = repositoryRoot;
  let candidateStats: Stats | undefined;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      candidateStats = await lstat(current);
    } catch (error) {
      if (
        allowMissing
        && current === absolutePath
        && (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return undefined;
      }
      return provenanceFailure(`Missing or unreadable ${label}`, {
        path: current,
        error: errorMessage(error),
      });
    }
    if (candidateStats.isSymbolicLink()) {
      return provenanceFailure("Authored source path contains a symbolic link", {
        repositoryRoot,
        path: absolutePath,
        symlink: current,
        label,
      });
    }
  }

  if (candidateStats === undefined) {
    return provenanceFailure(`Missing or unreadable ${label}`, { path: absolutePath });
  }
  if (kind === "file" ? !candidateStats.isFile() : !candidateStats.isDirectory()) {
    return provenanceFailure(`Authored ${label} is not a regular ${kind}`, { path: absolutePath });
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch (error) {
    return provenanceFailure(`Missing or unreadable ${label}`, {
      path: absolutePath,
      error: errorMessage(error),
    });
  }
  if (!pathIsWithinRoot(repositoryRoot, canonicalPath)) {
    return provenanceFailure("Authored source realpath escapes canonical repository root", {
      repositoryRoot,
      path: absolutePath,
      realpath: canonicalPath,
      label,
    });
  }
  return { absolutePath, stats: candidateStats };
}

async function readRequired(repositoryRoot: string, path: string, label: string): Promise<string> {
  const verified = await verifyAuthoredPath(repositoryRoot, path, label, "file");
  if (verified === undefined) {
    return provenanceFailure(`Missing or unreadable ${label}`, { path });
  }

  let handle: FileHandle | undefined;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    handle = await open(verified.absolutePath, constants.O_RDONLY | noFollow);
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) {
      return provenanceFailure(`Authored ${label} is not a regular file`, { path: verified.absolutePath });
    }
    const current = await verifyAuthoredPath(repositoryRoot, verified.absolutePath, label, "file");
    if (
      current === undefined
      || current.stats.dev !== openedStats.dev
      || current.stats.ino !== openedStats.ino
    ) {
      return provenanceFailure("Authored source changed while opening", {
        path: verified.absolutePath,
        label,
      });
    }
    return await handle.readFile({ encoding: "utf8" });
  } catch (error) {
    if (error instanceof CipherpolAdmissionError) throw error;
    return provenanceFailure(`Missing or unreadable ${label}`, {
      path: verified.absolutePath,
      error: errorMessage(error),
    });
  } finally {
    await handle?.close();
  }
}

function parseJsonObject(source: string, path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return provenanceFailure("Malformed JSON source", { path, error: errorMessage(error) });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return provenanceFailure("JSON source must contain an object", { path });
  }
  return parsed as Record<string, unknown>;
}

function stringArray(value: unknown, field: string, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    return provenanceFailure(`${field} must be an array of non-empty strings`, { path, field });
  }
  return value.map((item) => (item as string).trim());
}

function validateIncludePattern(pattern: string, module: SoftwareDevAgenticModule, path: string): void {
  const segments = pattern.split("/");
  if (
    pattern.startsWith("/")
    || pattern.includes("\\")
    || segments.includes("..")
    || segments.includes("dist")
    || segments[0] !== module
  ) {
    provenanceFailure("Build include pattern is outside the authored module source", {
      path,
      module,
      pattern,
    });
  }
}

function parseBuildConfig(
  source: string,
  path: string,
  expectedModule: SoftwareDevAgenticModule,
): BuildConfig {
  const raw = parseJsonObject(source, path);
  if (raw.name !== expectedModule) {
    return provenanceFailure("Build config module name mismatch", {
      path,
      expected: expectedModule,
      actual: raw.name,
    });
  }
  if (raw.include === null || typeof raw.include !== "object" || Array.isArray(raw.include)) {
    return provenanceFailure("Build config requires an include object", { path });
  }
  const include = raw.include as Record<string, unknown>;
  const agents = stringArray(include.agents, "include.agents", path);
  const skills = stringArray(include.skills, "include.skills", path);
  const reference = stringArray(include.reference, "include.reference", path);
  for (const pattern of [...agents, ...skills, ...reference]) {
    validateIncludePattern(pattern, expectedModule, path);
  }
  if (raw.mcp_server !== undefined && typeof raw.mcp_server !== "string") {
    return provenanceFailure("mcp_server must be a string", { path });
  }
  const config: BuildConfig = {
    name: expectedModule,
    include: { agents, skills, reference },
  };
  if (typeof raw.mcp_server === "string") config.mcpServer = raw.mcp_server;
  return config;
}

function parseMarketplace(source: string, path: string): MarketplacePlugin[] {
  const raw = parseJsonObject(source, path);
  if (!Array.isArray(raw.plugins)) {
    return provenanceFailure("Marketplace requires a plugins array", { path });
  }
  return raw.plugins.map((plugin, index) => {
    if (plugin === null || typeof plugin !== "object" || Array.isArray(plugin)) {
      return provenanceFailure("Marketplace plugin must be an object", { path, index });
    }
    const value = plugin as Record<string, unknown>;
    if (typeof value.name !== "string" || typeof value.version !== "string") {
      return provenanceFailure("Marketplace plugin requires name and version", { path, index });
    }
    return { name: value.name, version: value.version };
  });
}

function authoredRelativePath(repositoryRoot: string, absolutePath: string): string {
  const sourcePath = relative(repositoryRoot, absolutePath);
  if (sourcePath === "" || sourcePath === ".." || sourcePath.startsWith(`..${sep}`) || isAbsolute(sourcePath)) {
    return provenanceFailure("Selected source escapes repository root", { absolutePath });
  }
  const portable = sourcePath.split(sep).join("/");
  if (portable.split("/").includes("dist")) {
    return provenanceFailure("Built dist output cannot be used as importer source", { sourcePath: portable });
  }
  return portable;
}

async function matchingDirectories(repositoryRoot: string, pattern: string): Promise<string[]> {
  const normalizedPattern = pattern.replace(/\/+$/, "");
  const matches: string[] = [];
  for await (const candidate of glob(normalizedPattern, { cwd: repositoryRoot })) {
    const absolutePath = resolve(repositoryRoot, candidate);
    const verified = await verifyAuthoredPath(
      repositoryRoot,
      absolutePath,
      `configured include root for ${pattern}`,
      "directory",
    );
    if (verified !== undefined) matches.push(verified.absolutePath);
  }
  return matches.sort((left, right) => left.localeCompare(right));
}

async function markdownFiles(repositoryRoot: string, directory: string): Promise<string[]> {
  const verifiedDirectory = await verifyAuthoredPath(
    repositoryRoot,
    directory,
    "traversed Markdown directory",
    "directory",
  );
  if (verifiedDirectory === undefined) {
    return provenanceFailure("Configured Markdown directory is missing", { directory });
  }
  const files: string[] = [];
  let children;
  try {
    children = await readdir(verifiedDirectory.absolutePath, { withFileTypes: true });
  } catch (error) {
    return provenanceFailure("Configured Markdown directory is unreadable", {
      directory: verifiedDirectory.absolutePath,
      error: errorMessage(error),
    });
  }
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const path = join(verifiedDirectory.absolutePath, child.name);
    if (child.isSymbolicLink()) {
      await verifyAuthoredPath(repositoryRoot, path, "traversed Markdown source", "file");
    } else if (child.isDirectory()) {
      files.push(...await markdownFiles(repositoryRoot, path));
    } else if (child.isFile() && child.name.endsWith(".md")) {
      const verifiedFile = await verifyAuthoredPath(
        repositoryRoot,
        path,
        "selected Markdown source",
        "file",
      );
      if (verifiedFile !== undefined) files.push(verifiedFile.absolutePath);
    }
  }
  return files;
}

function registerSelection(
  selectedBySource: Map<string, SelectedMarkdown>,
  sourceByTarget: Map<string, string>,
  selection: SelectedMarkdown,
): void {
  const existingSource = sourceByTarget.get(selection.targetPath);
  if (existingSource !== undefined && existingSource !== selection.sourcePath) {
    duplicateFailure("Flattened build target collision", {
      targetPath: selection.targetPath,
      sources: [existingSource, selection.sourcePath].sort(),
    });
  }
  sourceByTarget.set(selection.targetPath, selection.sourcePath);
  if (!selectedBySource.has(selection.sourcePath)) selectedBySource.set(selection.sourcePath, selection);
}

async function selectMarkdown(
  repositoryRoot: string,
  module: SoftwareDevAgenticModule,
  moduleVersion: string,
  config: BuildConfig,
): Promise<SelectedMarkdown[]> {
  const selectedBySource = new Map<string, SelectedMarkdown>();
  const sourceByTarget = new Map<string, string>();

  for (const pattern of config.include.agents) {
    for (const directory of await matchingDirectories(repositoryRoot, pattern)) {
      for (const file of await markdownFiles(repositoryRoot, directory)) {
        const sourcePath = authoredRelativePath(repositoryRoot, file);
        registerSelection(selectedBySource, sourceByTarget, {
          module,
          moduleVersion,
          sourcePath,
          targetPath: `agents/${basename(file)}`,
          includePattern: pattern,
          selection: "agent",
        });
      }
    }
  }

  for (const pattern of config.include.skills) {
    for (const directory of await matchingDirectories(repositoryRoot, pattern)) {
      const verifiedSkill = await verifyAuthoredPath(
        repositoryRoot,
        join(directory, "SKILL.md"),
        "selected skill source",
        "file",
        true,
      );
      if (verifiedSkill === undefined) continue;
      const skillPath = verifiedSkill.absolutePath;
      const sourcePath = authoredRelativePath(repositoryRoot, skillPath);
      registerSelection(selectedBySource, sourceByTarget, {
        module,
        moduleVersion,
        sourcePath,
        targetPath: `skills/${basename(directory)}/SKILL.md`,
        includePattern: pattern,
        selection: "skill",
      });
    }
  }

  for (const pattern of config.include.reference) {
    for (const directory of await matchingDirectories(repositoryRoot, pattern)) {
      const persona = basename(dirname(directory));
      for (const file of await markdownFiles(repositoryRoot, directory)) {
        const nestedPath = relative(directory, file).split(sep).join("/");
        const sourcePath = authoredRelativePath(repositoryRoot, file);
        registerSelection(selectedBySource, sourceByTarget, {
          module,
          moduleVersion,
          sourcePath,
          targetPath: `reference/${persona}/${nestedPath}`,
          includePattern: pattern,
          selection: "reference",
        });
      }
    }
  }

  return [...selectedBySource.values()].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

// Claude frontmatter defines description as free-form single-line text. Quote only
// that field before strict YAML parsing so authored `Decision: ...` text stays scalar.
function normalizedFrontmatterYaml(source: string): string {
  return source.split("\n").map((line) => {
    const match = /^description:\s*(.*)$/.exec(line);
    if (!match) return line;
    const value = match[1] ?? "";
    if (/^(?:["'|>]|$)/.test(value)) return line;
    return `description: ${JSON.stringify(value)}`;
  }).join("\n");
}

function parsePermissionList(value: unknown, field: string, path: string): string[] {
  if (value === undefined) return [];
  const values = typeof value === "string" ? value.split(",") : value;
  return [...new Set(stringArray(values, field, path))].sort();
}

function parseOptionalNameList(value: unknown, field: string, path: string): string[] {
  if (value === undefined) return [];
  return [...new Set(stringArray(value, field, path))].sort();
}

function parseFrontmatter(markdown: string, path: string): Frontmatter {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return provenanceFailure("Markdown artifact is missing YAML frontmatter", { path });
  }
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    return provenanceFailure("Markdown artifact has unterminated YAML frontmatter", { path });
  }
  const document = parseDocument(normalizedFrontmatterYaml(normalized.slice(4, closing)), {
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    return provenanceFailure("Malformed YAML frontmatter", {
      path,
      issues: document.errors.map((error) => error.message),
    });
  }
  const raw: unknown = document.toJS();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return provenanceFailure("YAML frontmatter must contain an object", { path });
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value.name)) {
    return provenanceFailure("Frontmatter name must be a stable kebab-case name", { path, name: value.name });
  }
  if (typeof value.description !== "string" || value.description.trim() === "") {
    return provenanceFailure("Frontmatter description must be a non-empty string", { path });
  }
  if (value["user-invocable"] !== undefined && typeof value["user-invocable"] !== "boolean") {
    return provenanceFailure("user-invocable must be a boolean", { path });
  }
  const permissions = [
    ...parsePermissionList(value["allowed-tools"], "allowed-tools", path),
    ...parsePermissionList(value.tools, "tools", path),
  ];
  const frontmatter: Frontmatter = {
    name: value.name,
    description: value.description.trim(),
    permissions: [...new Set(permissions)].sort(),
    relatedSkills: parseOptionalNameList(value.related_skills, "related_skills", path),
    agents: parseOptionalNameList(value.agents, "agents", path),
  };
  if (typeof value["user-invocable"] === "boolean") frontmatter.userInvocable = value["user-invocable"];
  return frontmatter;
}

function platformForPath(sourcePath: string): string[] {
  const match = /\/platforms\/([^/]+)\//.exec(`/${sourcePath}`);
  return [match?.[1] ?? "generic"];
}

function artifactTypeForSkill(sourcePath: string): ParityEntryV2["artifactType"] {
  if (sourcePath.includes("/skills/orchestrators/")) return "orchestrator";
  if (sourcePath.includes("/skills/procedures/")) return "internal-procedure";
  if (sourcePath.includes("/skills/contract/")) return "contract";
  return provenanceFailure("Selected skill is outside a recognized shipping classification", { sourcePath });
}

function entryId(module: SoftwareDevAgenticModule, kind: ParityEntryV2["artifactType"], name: string): string {
  return `${NAMESPACE_BY_MODULE[module]}/${kind}/${name.toLowerCase()}`;
}

function referenceName(targetPath: string): string {
  return targetPath.replace(/^reference\//, "").replace(/\.md$/, "");
}

function evidenceFor(selection: SelectedMarkdown, name: string): string[] {
  return [
    `build-config:${selection.module}/plugin/build.config.json#${selection.includePattern}`,
    `frontmatter:${selection.sourcePath}#name=${name}`,
  ];
}

async function createMarkdownEntries(
  repositoryRoot: string,
  selections: readonly SelectedMarkdown[],
  sourceRevision: string,
): Promise<{ entries: ParityEntryV2[]; metadata: Map<string, EntryMetadata> }> {
  const entries: ParityEntryV2[] = [];
  const metadata = new Map<string, EntryMetadata>();
  const sourceById = new Map<string, string>();

  for (const selection of selections) {
    const body = await readRequired(
      repositoryRoot,
      resolve(repositoryRoot, selection.sourcePath),
      "authored Markdown artifact",
    );
    if (selection.selection === "reference") {
      const name = referenceName(selection.targetPath);
      const id = entryId(selection.module, "reference", name);
      const existing = sourceById.get(id);
      if (existing !== undefined) duplicateFailure("Duplicate parity entry ID", { id, sources: [existing, selection.sourcePath] });
      sourceById.set(id, selection.sourcePath);
      entries.push(parityEntryV2Schema.parse({
        id,
        name,
        module: selection.module,
        moduleVersion: selection.moduleVersion,
        sourceRevision,
        sourcePath: selection.sourcePath,
        artifactType: "reference",
        shipped: true,
        state: "equivalent",
        composition: [],
        dependencies: [],
        platforms: platformForPath(selection.sourcePath),
        permissions: [],
        toolCapabilities: [],
        mcpCapabilities: [],
        evidence: [`build-config:${selection.module}/plugin/build.config.json#${selection.includePattern}`],
      }));
      metadata.set(id, { body, relatedSkills: [], agents: [] });
      continue;
    }

    const frontmatter = parseFrontmatter(body, selection.sourcePath);
    const artifactType = selection.selection === "agent" ? "agent" : artifactTypeForSkill(selection.sourcePath);
    const id = entryId(selection.module, artifactType, frontmatter.name);
    const existing = sourceById.get(id);
    if (existing !== undefined) duplicateFailure("Duplicate parity entry ID", { id, sources: [existing, selection.sourcePath] });
    sourceById.set(id, selection.sourcePath);
    const toolCapabilities = frontmatter.permissions.filter((tool) => !tool.startsWith("mcp__"));
    const mcpCapabilities = frontmatter.permissions.filter((tool) => tool.startsWith("mcp__"));
    entries.push(parityEntryV2Schema.parse({
      id,
      name: frontmatter.name,
      module: selection.module,
      moduleVersion: selection.moduleVersion,
      sourceRevision,
      sourcePath: selection.sourcePath,
      artifactType,
      shipped: true,
      state: "equivalent",
      ...(frontmatter.userInvocable === undefined ? {} : { userInvocable: frontmatter.userInvocable }),
      ...(frontmatter.userInvocable === true ? { trigger: frontmatter.description } : {}),
      composition: [],
      dependencies: [],
      platforms: platformForPath(selection.sourcePath),
      permissions: frontmatter.permissions,
      toolCapabilities,
      mcpCapabilities,
      evidence: evidenceFor(selection, frontmatter.name),
    }));
    metadata.set(id, {
      body,
      relatedSkills: frontmatter.relatedSkills,
      agents: frontmatter.agents,
    });
  }

  return { entries, metadata };
}

function uniqueByName(
  entries: readonly ParityEntryV2[],
  kinds: readonly ParityEntryV2["artifactType"][],
): Map<string, string> {
  const ids = new Map<string, string>();
  for (const entry of entries) {
    if (!kinds.includes(entry.artifactType)) continue;
    const key = `${entry.module}/${entry.name}`;
    const existing = ids.get(key);
    if (existing !== undefined && existing !== entry.id) {
      duplicateFailure("Flattened authored name collision", {
        module: entry.module,
        name: entry.name,
        ids: [existing, entry.id].sort(),
      });
    }
    ids.set(key, entry.id);
  }
  return ids;
}

function resolveEntryRelationships(entries: ParityEntryV2[], metadata: ReadonlyMap<string, EntryMetadata>): void {
  const skillIds = uniqueByName(entries, ["orchestrator", "internal-procedure", "contract"]);
  const agentIds = uniqueByName(entries, ["agent"]);
  const referenceIds = new Map<string, string>(
    entries.filter((entry) => entry.artifactType === "reference")
      .map((entry) => [`${entry.module}/reference/${entry.name}.md`, entry.id] as const),
  );
  const procedurePattern = /\$CLAUDE_PLUGIN_ROOT\/skills\/([a-z0-9-]+)\/procedure\.md/g;
  const referencePattern = /\$CLAUDE_PLUGIN_ROOT\/(reference\/[A-Za-z0-9._/-]+\.md)/g;

  for (const entry of entries) {
    const data = metadata.get(entry.id);
    if (data === undefined) continue;
    const composition = new Set<string>();
    const dependencies = new Set<string>();

    for (const match of data.body.matchAll(procedurePattern)) {
      const name = match[1];
      const target = name === undefined ? undefined : skillIds.get(`${entry.module}/${name}`);
      if (target === undefined) provenanceFailure("Procedure composition target is not shipped", { sourcePath: entry.sourcePath, name });
      composition.add(target);
    }
    for (const name of data.agents) {
      const target = agentIds.get(`${entry.module}/${name}`);
      if (target === undefined) provenanceFailure("Agent composition target is not shipped", { sourcePath: entry.sourcePath, name });
      composition.add(target);
    }
    for (const name of data.relatedSkills) {
      const target = skillIds.get(`${entry.module}/${name}`);
      if (target === undefined) provenanceFailure("Related skill dependency is not shipped", { sourcePath: entry.sourcePath, name });
      dependencies.add(target);
    }
    for (const match of data.body.matchAll(referencePattern)) {
      const targetPath = match[1];
      const target = targetPath === undefined ? undefined : referenceIds.get(`${entry.module}/${targetPath}`);
      if (target === undefined) provenanceFailure("Reference dependency is not shipped", { sourcePath: entry.sourcePath, targetPath });
      dependencies.add(target);
    }

    entry.composition = [...composition].sort();
    entry.dependencies = [...dependencies].sort();
  }
}

async function createTaxonomyEntry(
  repositoryRoot: string,
  sourceRevision: string,
  moduleVersion: string,
): Promise<ParityEntryV2> {
  const buildScriptPath = "cipherpol-aegis/plugin/build.sh";
  const buildScript = await readRequired(
    repositoryRoot,
    resolve(repositoryRoot, buildScriptPath),
    "cipherpol-aegis build script",
  );
  const shippingCommand = /cp\s+"\$SUBMODULE\/cipherpol\.json"\s+"\$out\/reference\/cipherpol\.json"/;
  if (!shippingCommand.test(buildScript)) {
    return provenanceFailure("Aegis taxonomy shipping command does not match the admitted source contract", {
      path: buildScriptPath,
    });
  }
  const sourcePath = "cipherpol.json";
  const taxonomy = parseJsonObject(
    await readRequired(repositoryRoot, resolve(repositoryRoot, sourcePath), "platform taxonomy"),
    sourcePath,
  );
  if (!Array.isArray(taxonomy.platforms)) {
    return provenanceFailure("Platform taxonomy requires a platforms array", { path: sourcePath });
  }
  const platforms = taxonomy.platforms.map((platform, index) => {
    if (platform === null || typeof platform !== "object" || Array.isArray(platform)) {
      return provenanceFailure("Taxonomy platform must be an object", { path: sourcePath, index });
    }
    const id = (platform as Record<string, unknown>).id;
    if (typeof id !== "string" || id.trim() === "") {
      return provenanceFailure("Taxonomy platform requires an id", { path: sourcePath, index });
    }
    return id;
  }).sort();

  return parityEntryV2Schema.parse({
    id: entryId("cipherpol-aegis", "taxonomy", "cipherpol"),
    name: "cipherpol",
    module: "cipherpol-aegis",
    moduleVersion,
    sourceRevision,
    sourcePath,
    artifactType: "taxonomy",
    shipped: true,
    state: "equivalent",
    composition: [],
    dependencies: [],
    platforms,
    permissions: [],
    toolCapabilities: [],
    mcpCapabilities: [],
    evidence: [
      `shipping-command:${buildScriptPath}#cipherpol.json->reference/cipherpol.json`,
      `taxonomy:${sourcePath}#platforms=${platforms.join(",")}`,
    ],
  });
}

function parseCp1Tools(source: string, sourcePath: string): Array<{ name: string; description: string }> {
  const starts = [...source.matchAll(/server\.registerTool\s*\(/g)];
  const registration = /server\.registerTool\s*\(\s*"([a-z0-9_]+)"\s*,\s*\{\s*description\s*:\s*"((?:\\.|[^"\\])*)"/g;
  const tools = [...source.matchAll(registration)].map((match) => {
    const name = match[1];
    const encodedDescription = match[2];
    if (name === undefined || encodedDescription === undefined) {
      return provenanceFailure("Malformed cp1 registerTool declaration", { sourcePath });
    }
    let description: string;
    try {
      description = JSON.parse(`"${encodedDescription}"`) as string;
    } catch (error) {
      return provenanceFailure("Malformed cp1 tool description literal", {
        sourcePath,
        name,
        error: errorMessage(error),
      });
    }
    if (description.trim() === "") provenanceFailure("cp1 tool description cannot be empty", { sourcePath, name });
    return { name, description };
  });
  if (starts.length !== EXPECTED_CP1_TOOL_COUNT || tools.length !== EXPECTED_CP1_TOOL_COUNT) {
    return provenanceFailure("cp1 tool source shape/count mismatch", {
      sourcePath,
      expected: EXPECTED_CP1_TOOL_COUNT,
      registerToolCalls: starts.length,
      parsedDeclarations: tools.length,
    });
  }
  const names = new Set(tools.map((tool) => tool.name));
  if (names.size !== tools.length) duplicateFailure("Duplicate cp1 MCP tool registration", { sourcePath });
  return tools.sort((left, right) => left.name.localeCompare(right.name));
}

async function createCp1ToolEntries(
  repositoryRoot: string,
  sourceRevision: string,
  moduleVersion: string,
  config: BuildConfig,
): Promise<ParityEntryV2[]> {
  if (config.mcpServer !== "cp1") {
    return provenanceFailure("cipherpol-1 build config must ship the cp1 MCP server", {
      actual: config.mcpServer,
    });
  }
  const sourcePath = "cipherpol-1/packages/mcp-server/src/create-server.ts";
  const tools = parseCp1Tools(
    await readRequired(repositoryRoot, resolve(repositoryRoot, sourcePath), "cp1 MCP server source"),
    sourcePath,
  );
  return tools.map((tool) => parityEntryV2Schema.parse({
    id: entryId("cipherpol-1", "mcp-tool", tool.name),
    name: tool.name,
    module: "cipherpol-1",
    moduleVersion,
    sourceRevision,
    sourcePath,
    artifactType: "mcp-tool",
    shipped: true,
    state: "equivalent",
    trigger: tool.description,
    composition: [],
    dependencies: [],
    platforms: ["generic"],
    permissions: [],
    toolCapabilities: [],
    mcpCapabilities: [tool.name],
    evidence: [
      `build-config:cipherpol-1/plugin/build.config.json#mcp_server=cp1`,
      `registration:${sourcePath}#server.registerTool(${tool.name})`,
    ],
  }));
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function requiredAdapterSource(
  repositoryRoot: string,
  sourcePath: string,
  kind: "file" | "directory",
): Promise<string> {
  const verified = await verifyAuthoredPath(
    repositoryRoot,
    resolve(repositoryRoot, sourcePath),
    "cp1 adapter deploy input",
    kind,
  );
  if (verified === undefined) {
    return provenanceFailure("Missing cp1 adapter deploy input", { sourcePath });
  }
  return authoredRelativePath(repositoryRoot, verified.absolutePath);
}

async function cp1AdapterSourcePaths(repositoryRoot: string): Promise<string[]> {
  const buildScriptPath = "cipherpol-1/plugin/build.sh";
  const buildScript = await readRequired(
    repositoryRoot,
    resolve(repositoryRoot, buildScriptPath),
    "cipherpol-1 build script",
  );
  const requiredDeployOperations: ReadonlyArray<readonly [string, RegExp]> = [
    ["workspace manifests", /cp\s+["']?\$MODULE["']?\/package\.json[\s\S]*?pnpm-lock\.yaml[\s\S]*?pnpm-workspace\.yaml[\s\S]*?tsconfig\.json[\s\S]*?tsconfig\.base\.json/],
    ["workspace package selection", /for\s+pkg_dir\s+in\s+["']?\$MODULE["']?\/packages\/\*\/[\s\S]*?\[\s+-f\s+["']?\$pkg_dir\/package\.json["']?\s+\]\s+&&\s+\[\s+-d\s+["']?\$pkg_dir\/src["']?\s+\]/],
    ["workspace source copy", /cp\s+-r\s+["']?\$pkg_dir\/src["']?/],
    ["workspace package metadata copy", /cp\s+["']?\$pkg_dir\/package\.json["']?\s+["']?\$pkg_dir\/tsconfig\.json["']?/],
    ["MCP Dockerfile", /cp\s+["']?\$MODULE\/packages\/mcp-server\/Dockerfile["']?/],
    ["compose inputs", /cp\s+["']?\$MODULE["']?\/deploy\/supabase-min\/\{docker-compose\.yml,Caddyfile,\.env\.example\}/],
    ["vendored volume inputs", /cp\s+-r\s+["']?\$MODULE\/deploy\/supabase-min\/volumes["']?/],
    ["Kong input", /cp\s+["']?\$MODULE\/deploy\/supabase-min\/kong\.yml["']?/],
    ["schema migrations", /cp\s+-r\s+["']?\$MODULE\/supabase\/migrations["']?/],
  ];
  for (const [operation, pattern] of requiredDeployOperations) {
    if (!pattern.test(buildScript)) {
      provenanceFailure("cipherpol-1 deploy build contract is missing a required authored selection", {
        path: buildScriptPath,
        operation,
      });
    }
  }

  const sourcePaths = await Promise.all([
    "cipherpol-1/package.json",
    "cipherpol-1/pnpm-lock.yaml",
    "cipherpol-1/pnpm-workspace.yaml",
    "cipherpol-1/tsconfig.json",
    "cipherpol-1/tsconfig.base.json",
    "cipherpol-1/packages/mcp-server/Dockerfile",
    "cipherpol-1/deploy/supabase-min/docker-compose.yml",
    "cipherpol-1/deploy/supabase-min/Caddyfile",
    "cipherpol-1/deploy/supabase-min/.env.example",
    "cipherpol-1/deploy/supabase-min/volumes",
    "cipherpol-1/deploy/supabase-min/kong.yml",
    "cipherpol-1/supabase/migrations",
  ].map((sourcePath) => requiredAdapterSource(
    repositoryRoot,
    sourcePath,
    sourcePath.endsWith("/volumes") || sourcePath.endsWith("/migrations") ? "directory" : "file",
  )));

  const packagesRootPath = "cipherpol-1/packages";
  const packagesRoot = await requiredAdapterSource(repositoryRoot, packagesRootPath, "directory");
  const children = await readdir(resolve(repositoryRoot, packagesRoot), { withFileTypes: true });
  children.sort((left, right) => compareCodePoints(left.name, right.name));
  for (const child of children) {
    const packageRoot = `${packagesRoot}/${child.name}`;
    if (child.isSymbolicLink()) {
      await requiredAdapterSource(repositoryRoot, packageRoot, "directory");
      continue;
    }
    if (!child.isDirectory()) continue;

    const packageJson = await verifyAuthoredPath(
      repositoryRoot,
      resolve(repositoryRoot, packageRoot, "package.json"),
      "cp1 workspace package manifest",
      "file",
      true,
    );
    const sourceDirectory = await verifyAuthoredPath(
      repositoryRoot,
      resolve(repositoryRoot, packageRoot, "src"),
      "cp1 workspace package source",
      "directory",
      true,
    );
    if (packageJson === undefined || sourceDirectory === undefined) continue;

    sourcePaths.push(
      authoredRelativePath(repositoryRoot, packageJson.absolutePath),
      await requiredAdapterSource(repositoryRoot, `${packageRoot}/tsconfig.json`, "file"),
      authoredRelativePath(repositoryRoot, sourceDirectory.absolutePath),
    );
  }

  const sorted = [...new Set(sourcePaths)].sort(compareCodePoints);
  if (sorted.some((sourcePath) => sourcePath.split("/").includes("dist"))) {
    provenanceFailure("cp1 adapter selection includes generated dist output", { sourcePaths: sorted });
  }
  return sorted;
}

function descriptorForMarkdown(
  selection: SelectedMarkdown,
  entry: ParityEntryV2,
): ImportedArtifactDescriptor {
  let packageKind: ImportedArtifactDescriptor["packageKind"];
  let sourceKind: ImportedArtifactDescriptor["sourceKind"];
  let sourcePaths: readonly string[];
  let targetRoot: string;
  switch (entry.artifactType) {
    case "orchestrator":
    case "contract":
      packageKind = "skill";
      sourceKind = "directory";
      sourcePaths = [dirname(selection.sourcePath).split(sep).join("/")];
      targetRoot = `skills/${entry.name}`;
      break;
    case "internal-procedure":
      packageKind = "procedure";
      sourceKind = "directory";
      sourcePaths = [dirname(selection.sourcePath).split(sep).join("/")];
      targetRoot = `skills/${entry.name}`;
      break;
    case "agent":
      packageKind = "agent";
      sourceKind = "file";
      sourcePaths = [selection.sourcePath];
      targetRoot = selection.targetPath;
      break;
    case "reference":
      packageKind = "reference";
      sourceKind = "file";
      sourcePaths = [selection.sourcePath];
      targetRoot = selection.targetPath;
      break;
    default:
      return provenanceFailure("Markdown selection produced an unsupported package artifact", {
        parityId: entry.id,
        artifactType: entry.artifactType,
      });
  }
  return {
    packageId: entry.id,
    parityIds: [entry.id],
    module: entry.module,
    moduleVersion: entry.moduleVersion,
    packageKind,
    sourceKind,
    sourcePaths,
    targetRoot,
  };
}

async function createArtifactDescriptors(
  repositoryRoot: string,
  selections: readonly SelectedMarkdown[],
  entries: readonly ParityEntryV2[],
  moduleVersions: Readonly<Record<SoftwareDevAgenticModule, string>>,
): Promise<ImportedArtifactDescriptor[]> {
  const entriesBySource = new Map<string, ParityEntryV2[]>();
  for (const entry of entries) {
    const sourceEntries = entriesBySource.get(entry.sourcePath) ?? [];
    sourceEntries.push(entry);
    entriesBySource.set(entry.sourcePath, sourceEntries);
  }

  const artifacts: ImportedArtifactDescriptor[] = [];
  for (const selection of selections) {
    const sourceEntries = entriesBySource.get(selection.sourcePath) ?? [];
    if (sourceEntries.length !== 1) {
      provenanceFailure("Authored Markdown source must map to exactly one parity entry", {
        sourcePath: selection.sourcePath,
        parityIds: sourceEntries.map((entry) => entry.id),
      });
    }
    const entry = sourceEntries[0];
    if (entry === undefined || entry.moduleVersion !== moduleVersions[entry.module]) {
      provenanceFailure("Descriptor module version does not match the imported module", {
        sourcePath: selection.sourcePath,
        module: entry?.module,
        moduleVersion: entry?.moduleVersion,
      });
    }
    artifacts.push(descriptorForMarkdown(selection, entry));
  }

  const taxonomy = entries.filter((entry) => entry.artifactType === "taxonomy");
  const taxonomyEntry = taxonomy[0];
  if (taxonomy.length !== 1 || taxonomyEntry === undefined) {
    provenanceFailure("Exactly one taxonomy parity entry must be imported", {
      parityIds: taxonomy.map((entry) => entry.id),
    });
  }
  artifacts.push({
    packageId: taxonomyEntry.id,
    parityIds: [taxonomyEntry.id],
    module: taxonomyEntry.module,
    moduleVersion: taxonomyEntry.moduleVersion,
    packageKind: "reference",
    sourceKind: "file",
    sourcePaths: [taxonomyEntry.sourcePath],
    targetRoot: "reference/cipherpol.json",
  });

  const cp1Entries = entries.filter((entry) => entry.artifactType === "mcp-tool")
    .sort((left, right) => compareCodePoints(left.id, right.id));
  if (
    cp1Entries.length !== EXPECTED_CP1_TOOL_COUNT
    || cp1Entries.some((entry) => entry.module !== "cipherpol-1"
      || entry.moduleVersion !== moduleVersions["cipherpol-1"])
  ) {
    provenanceFailure("cp1 adapter parity mappings do not match the imported module", {
      expected: EXPECTED_CP1_TOOL_COUNT,
      parityIds: cp1Entries.map((entry) => entry.id),
    });
  }
  artifacts.push({
    packageId: `${NAMESPACE_BY_MODULE["cipherpol-1"]}/adapter/cp1`,
    parityIds: cp1Entries.map((entry) => entry.id),
    module: "cipherpol-1",
    moduleVersion: moduleVersions["cipherpol-1"],
    packageKind: "adapter",
    sourceKind: "cp1-adapter",
    sourcePaths: await cp1AdapterSourcePaths(repositoryRoot),
    targetRoot: ".",
  });
  artifacts.sort((left, right) => compareCodePoints(left.packageId, right.packageId));
  const packageIds = new Set<string>();
  const mappedParityIds = new Set<string>();
  for (const artifact of artifacts) {
    if (packageIds.has(artifact.packageId)) {
      duplicateFailure("Duplicate materialization package ID", { packageId: artifact.packageId });
    }
    packageIds.add(artifact.packageId);
    if (artifact.sourcePaths.length === 0) {
      provenanceFailure("Materialization descriptor has no authored source", { packageId: artifact.packageId });
    }
    for (const parityId of artifact.parityIds) {
      if (mappedParityIds.has(parityId)) {
        duplicateFailure("Parity entry maps to multiple materialization packages", { parityId });
      }
      mappedParityIds.add(parityId);
    }
  }
  const parityIds = new Set(entries.map((entry) => entry.id));
  if (
    mappedParityIds.size !== parityIds.size
    || [...parityIds].some((parityId) => !mappedParityIds.has(parityId))
  ) {
    provenanceFailure("Every imported parity entry must map to exactly one materialization package", {
      mapped: mappedParityIds.size,
      imported: parityIds.size,
    });
  }
  return artifacts;
}

async function loadModuleInputs(repositoryRoot: string): Promise<{
  configs: Record<SoftwareDevAgenticModule, BuildConfig>;
  versions: Record<SoftwareDevAgenticModule, string>;
}> {
  const marketplacePath = ".claude-plugin/marketplace.json";
  const marketplace = parseMarketplace(
    await readRequired(repositoryRoot, resolve(repositoryRoot, marketplacePath), "marketplace manifest"),
    marketplacePath,
  );
  const marketplaceByName = new Map<string, string>();
  for (const plugin of marketplace) {
    if (marketplaceByName.has(plugin.name)) {
      duplicateFailure("Duplicate marketplace plugin", { name: plugin.name });
    }
    marketplaceByName.set(plugin.name, plugin.version);
  }

  const configs = {} as Record<SoftwareDevAgenticModule, BuildConfig>;
  const versions = {} as Record<SoftwareDevAgenticModule, string>;
  for (const module of MODULES) {
    const expectedVersion = SOFTWARE_DEV_AGENTIC_VERSIONS[module];
    const versionPath = `${module}/VERSION`;
    const actualVersion = (
      await readRequired(repositoryRoot, resolve(repositoryRoot, versionPath), `${module} VERSION`)
    ).trim();
    const marketplaceVersion = marketplaceByName.get(module);
    if (actualVersion !== expectedVersion || marketplaceVersion !== expectedVersion) {
      provenanceFailure("Module and marketplace versions must match the admitted shipping version", {
        module,
        expectedVersion,
        actualVersion,
        marketplaceVersion,
      });
    }
    const configPath = `${module}/plugin/build.config.json`;
    configs[module] = parseBuildConfig(
      await readRequired(repositoryRoot, resolve(repositoryRoot, configPath), `${module} build config`),
      configPath,
      module,
    );
    versions[module] = actualVersion;
  }
  return { configs, versions };
}

export async function importSoftwareDevAgenticArtifacts(
  options: ImportSoftwareDevAgenticOptions,
): Promise<SoftwareDevAgenticImportResult> {
  if (options.sourceRevision.trim().length < 7 || /\s/.test(options.sourceRevision)) {
    provenanceFailure("sourceRevision must be a non-whitespace revision of at least seven characters", {
      sourceRevision: options.sourceRevision,
    });
  }
  const repositoryRoot = await canonicalRepositoryRoot(options.repositoryRoot);

  const { configs, versions } = await loadModuleInputs(repositoryRoot);
  const selections: SelectedMarkdown[] = [];
  for (const module of MODULES) {
    selections.push(...await selectMarkdown(repositoryRoot, module, versions[module], configs[module]));
  }
  const { entries, metadata } = await createMarkdownEntries(repositoryRoot, selections, options.sourceRevision);
  entries.push(await createTaxonomyEntry(repositoryRoot, options.sourceRevision, versions["cipherpol-aegis"]));
  entries.push(...await createCp1ToolEntries(
    repositoryRoot,
    options.sourceRevision,
    versions["cipherpol-1"],
    configs["cipherpol-1"],
  ));
  resolveEntryRelationships(entries, metadata);
  entries.sort((left, right) => left.id.localeCompare(right.id));
  const manifest = buildParityManifest(options.sourceRevision, entries);
  const artifacts = await createArtifactDescriptors(
    repositoryRoot,
    selections,
    manifest.entries,
    versions,
  );

  return {
    sourceRevision: options.sourceRevision,
    moduleVersions: versions,
    entries: manifest.entries,
    manifest,
    measured: measureParityEntries(manifest.entries),
    artifacts,
  };
}

export async function measureSoftwareDevAgenticCorpus(
  options: ImportSoftwareDevAgenticOptions,
): Promise<SoftwareDevAgenticImportResult> {
  const result = await importSoftwareDevAgenticArtifacts(options);
  verifyParityBaseline(result.manifest);
  return result;
}
