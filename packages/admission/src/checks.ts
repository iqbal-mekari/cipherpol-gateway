import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CipherpolAdmissionError } from "./errors.js";

export const PROCEDURE_INCLUDE_PATTERN =
  /\$CLAUDE_PLUGIN_ROOT\/skills\/([a-z0-9-]+)\/procedure\.md/g;
export const PROCEDURE_BANNER_START_PATTERN = /^>\s*Executed by:/;
export const PROCEDURE_BANNER_BULLET_PATTERN = /^>\s*-\s/;
export const PROCEDURE_BANNER_NAME_PATTERN = /`\/([a-z0-9-]+)`/g;
export const SKILL_ALLOWED_TOOLS_PATTERN = /^allowed-tools:\s*(.+)$/m;
export const SKILL_TOOL_WAIVER_PATTERN = /tool-waiver:\s*([A-Za-z_][A-Za-z0-9_]*)/g;

export const AGENT_TOOLS_PATTERN = /^tools:\s*(.+)$/m;
export const AGENT_CONTEXT_WAIVER_PATTERN = /context-waiver:\s*(\S)/;
export const SEARCH_AGENT_TOOLS = ["Glob", "Grep"] as const;
export const ENFORCED_AGENT_PREFIXES = ["developer-", "aegis-"] as const;
export const FORBIDDEN_AGENT_ROOT_DERIVATIONS = [
  "git rev-parse --show-toplevel",
  "basename $(pwd)",
] as const;

export type ProcedureViolation =
  | {
      readonly kind: "missing-banner";
      readonly skillName: string;
      readonly filePath: string;
    }
  | {
      readonly kind: "missing-procedure";
      readonly callerName: string;
      readonly targetName: string;
      readonly sourcePaths: readonly string[];
    }
  | {
      readonly kind: "banner-omits-caller";
      readonly callerName: string;
      readonly targetName: string;
      readonly filePath: string;
    }
  | {
      readonly kind: "unknown-banner-caller";
      readonly callerName: string;
      readonly targetName: string;
      readonly filePath: string;
    }
  | {
      readonly kind: "stale-banner-caller";
      readonly callerName: string;
      readonly targetName: string;
      readonly filePath: string;
    }
  | {
      readonly kind: "missing-tool-grant";
      readonly skillName: string;
      readonly filePath: string;
      readonly missingTools: readonly string[];
      readonly includedSkills: readonly string[];
    };

export interface ProcedureCheckReport {
  readonly skillCount: number;
  readonly procedureCount: number;
  readonly includeEdgeCount: number;
}

export type AgentContextViolation =
  | {
      readonly kind: "missing-project-root";
      readonly agentName: string;
      readonly filePath: string;
    }
  | {
      readonly kind: "forbidden-root-derivation";
      readonly agentName: string;
      readonly filePath: string;
      readonly derivation: (typeof FORBIDDEN_AGENT_ROOT_DERIVATIONS)[number];
    };

export interface AgentContextCheckReport {
  readonly agentFileCount: number;
  readonly searchAgentsChecked: number;
  readonly waivedSearchAgents: number;
  readonly pendingSearchAgents: number;
}

interface ProcedureEdge {
  readonly callerName: string;
  readonly targetName: string;
  readonly sourcePaths: Set<string>;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isDirectory(path: string): boolean {
  return existsSync(path) && lstatSync(path).isDirectory();
}

function isFile(path: string): boolean {
  return existsSync(path) && lstatSync(path).isFile();
}


function collectCaptures(body: string, pattern: RegExp): string[] {
  const matches: string[] = [];
  const freshPattern = new RegExp(pattern.source, pattern.flags);
  for (const match of body.matchAll(freshPattern)) {
    const capture = match[1];
    if (capture !== undefined) {
      matches.push(capture);
    }
  }
  return matches;
}

function parseCommaSeparatedLine(body: string, pattern: RegExp): Set<string> | undefined {
  const match = pattern.exec(body);
  if (match?.[1] === undefined) {
    return undefined;
  }
  return new Set(
    match[1]
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

function parseProcedureBanner(procedureBody: string): Set<string> {
  const callers = new Set<string>();
  let inBanner = false;

  for (const line of procedureBody.split(/\r?\n/)) {
    if (PROCEDURE_BANNER_START_PATTERN.test(line)) {
      inBanner = true;
      continue;
    }
    if (!inBanner) {
      continue;
    }
    if (PROCEDURE_BANNER_BULLET_PATTERN.test(line)) {
      const declaration = line.split("—", 1)[0] ?? "";
      for (const callerName of collectCaptures(declaration, PROCEDURE_BANNER_NAME_PATTERN)) {
        callers.add(callerName);
      }
    } else if (!line.startsWith(">") || line.trim() === ">") {
      inBanner = false;
    }
  }

  return callers;
}

function formatProcedureViolation(violation: ProcedureViolation): string {
  switch (violation.kind) {
    case "missing-banner":
      return `${violation.filePath}: no nonempty Executed by banner`;
    case "missing-procedure":
      return `${violation.callerName}: loads absent ${violation.targetName}/procedure.md from ${violation.sourcePaths.join(", ")}`;
    case "banner-omits-caller":
      return `${violation.filePath}: banner omits /${violation.callerName}`;
    case "unknown-banner-caller":
      return `${violation.filePath}: banner names unknown /${violation.callerName}`;
    case "stale-banner-caller":
      return `${violation.filePath}: banner names /${violation.callerName}, which never loads it`;
    case "missing-tool-grant":
      return `${violation.filePath}: allowed-tools missing ${violation.missingTools.join(", ")}`;
  }
}


export function checkProcedures(skillsDirectory: string): ProcedureCheckReport {
  if (!isDirectory(skillsDirectory)) {
    throw new CipherpolAdmissionError(
      "INVALID_PROCEDURE_GRAPH",
      "Required flat skills view is missing or is not a directory",
      { skillsDirectory, reason: "missing-skills-view" },
    );
  }

  const files = new Map<string, Buffer>();
  for (const skillName of readdirSync(skillsDirectory)) {
    const skillDirectory = join(skillsDirectory, skillName);
    if (lstatSync(skillDirectory).isSymbolicLink()) {
      throw new CipherpolAdmissionError(
        "INVALID_PROCEDURE_GRAPH",
        `Symbolic links are not allowed in the flat skills view: ${skillName}`,
        { skillsDirectory, filePath: skillName, reason: "symbolic-link" },
      );
    }
    if (!isDirectory(skillDirectory)) {
      continue;
    }

    const skillFile = join(skillDirectory, "SKILL.md");
    if (existsSync(skillFile) && lstatSync(skillFile).isSymbolicLink()) {
      throw new CipherpolAdmissionError(
        "INVALID_PROCEDURE_GRAPH",
        `Symbolic links are not allowed in the flat skills view: ${skillName}/SKILL.md`,
        { skillsDirectory, filePath: `${skillName}/SKILL.md`, reason: "symbolic-link" },
      );
    }
    if (!isFile(skillFile)) {
      continue;
    }
    files.set(`${skillName}/SKILL.md`, readFileSync(skillFile));

    const procedurePath = join(skillDirectory, "procedure.md");
    if (existsSync(procedurePath) && lstatSync(procedurePath).isSymbolicLink()) {
      throw new CipherpolAdmissionError(
        "INVALID_PROCEDURE_GRAPH",
        `Symbolic links are not allowed in the flat skills view: ${skillName}/procedure.md`,
        {
          skillsDirectory,
          filePath: `${skillName}/procedure.md`,
          reason: "symbolic-link",
        },
      );
    }
    if (isFile(procedurePath)) {
      files.set(`${skillName}/procedure.md`, readFileSync(procedurePath));
    }
  }

  return checkProceduresFromFiles(files, skillsDirectory);
}


/**
 * Reproduces the shipping procedure gate against a built flat skills/<name>/ view.
 * Only literal includes in SKILL.md and procedure.md contribute graph edges.
 */
export function checkProceduresFromFiles(
  files: ReadonlyMap<string, Buffer>,
  skillsDirectory: string,
): ProcedureCheckReport {
  const skillNames = [...files.keys()]
    .flatMap((filePath) => {
      const match = /^([^/]+)\/SKILL\.md$/.exec(filePath);
      return match?.[1] === undefined ? [] : [match[1]];
    })
    .sort(compareStrings);
  const skillNameSet = new Set(skillNames);
  const procedureNames = new Set<string>();
  const banners = new Map<string, Set<string>>();
  const tools = new Map<string, Set<string> | undefined>();
  const waivers = new Map<string, Set<string>>();
  const edgesByKey = new Map<string, ProcedureEdge>();
  const violations: ProcedureViolation[] = [];

  for (const skillName of skillNames) {
    const skillBody = files.get(`${skillName}/SKILL.md`)!.toString("utf8");
    const procedureContent = files.get(`${skillName}/procedure.md`);
    const procedureBody = procedureContent?.toString("utf8");
    tools.set(skillName, parseCommaSeparatedLine(skillBody, SKILL_ALLOWED_TOOLS_PATTERN));
    waivers.set(skillName, new Set(collectCaptures(skillBody, SKILL_TOOL_WAIVER_PATTERN)));

    const executableFiles: readonly [string, string][] = procedureBody === undefined
      ? [[`${skillName}/SKILL.md`, skillBody]]
      : [
          [`${skillName}/SKILL.md`, skillBody],
          [`${skillName}/procedure.md`, procedureBody],
        ];

    for (const [sourcePath, body] of executableFiles) {
      for (const targetName of collectCaptures(body, PROCEDURE_INCLUDE_PATTERN)) {
        const key = `${skillName}\u0000${targetName}`;
        const existing = edgesByKey.get(key);
        if (existing === undefined) {
          edgesByKey.set(key, {
            callerName: skillName,
            targetName,
            sourcePaths: new Set([sourcePath]),
          });
        } else {
          existing.sourcePaths.add(sourcePath);
        }
      }
    }

    if (procedureBody !== undefined) {
      procedureNames.add(skillName);
      const declaredCallers = parseProcedureBanner(procedureBody);
      banners.set(skillName, declaredCallers);
      if (declaredCallers.size === 0) {
        violations.push({
          kind: "missing-banner",
          skillName,
          filePath: `${skillName}/procedure.md`,
        });
      }
    }
  }

  const edges = [...edgesByKey.values()].sort((left, right) => {
    const callerOrder = compareStrings(left.callerName, right.callerName);
    return callerOrder === 0 ? compareStrings(left.targetName, right.targetName) : callerOrder;
  });

  for (const edge of edges) {
    if (!procedureNames.has(edge.targetName)) {
      violations.push({
        kind: "missing-procedure",
        callerName: edge.callerName,
        targetName: edge.targetName,
        sourcePaths: [...edge.sourcePaths].sort(compareStrings),
      });
    } else if (!banners.get(edge.targetName)?.has(edge.callerName)) {
      violations.push({
        kind: "banner-omits-caller",
        callerName: edge.callerName,
        targetName: edge.targetName,
        filePath: `${edge.targetName}/procedure.md`,
      });
    }
  }

  for (const [targetName, declaredCallers] of banners) {
    for (const callerName of [...declaredCallers].sort(compareStrings)) {
      const filePath = `${targetName}/procedure.md`;
      if (!skillNameSet.has(callerName)) {
        violations.push({
          kind: "unknown-banner-caller",
          callerName,
          targetName,
          filePath,
        });
      } else if (!edgesByKey.has(`${callerName}\u0000${targetName}`)) {
        violations.push({
          kind: "stale-banner-caller",
          callerName,
          targetName,
          filePath,
        });
      }
    }
  }

  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.callerName) ?? new Set<string>();
    targets.add(edge.targetName);
    adjacency.set(edge.callerName, targets);
  }

  for (const skillName of skillNames) {
    const grantedTools = tools.get(skillName);
    if (grantedTools === undefined) {
      continue;
    }

    const reached = new Set<string>();
    const stack = [...(adjacency.get(skillName) ?? [])];
    while (stack.length > 0) {
      const targetName = stack.pop()!;
      if (targetName === skillName || reached.has(targetName)) {
        continue;
      }
      reached.add(targetName);
      stack.push(...(adjacency.get(targetName) ?? []));
    }

    const requiredTools = new Set<string>();
    for (const targetName of reached) {
      for (const tool of tools.get(targetName) ?? []) {
        requiredTools.add(tool);
      }
    }
    const waivedTools = waivers.get(skillName) ?? new Set<string>();
    const missingTools = [...requiredTools]
      .filter((tool) => !grantedTools.has(tool) && !waivedTools.has(tool))
      .sort(compareStrings);
    if (missingTools.length > 0) {
      violations.push({
        kind: "missing-tool-grant",
        skillName,
        filePath: `${skillName}/SKILL.md`,
        missingTools,
        includedSkills: [...reached].sort(compareStrings),
      });
    }
  }

  if (violations.length > 0) {
    throw new CipherpolAdmissionError(
      "INVALID_PROCEDURE_GRAPH",
      `Invalid procedure graph:\n${violations.map(formatProcedureViolation).join("\n")}`,
      { skillsDirectory, violations },
    );
  }

  return {
    skillCount: skillNames.length,
    procedureCount: procedureNames.size,
    includeEdgeCount: edges.length,
  };
}


function formatAgentContextViolation(violation: AgentContextViolation): string {
  if (violation.kind === "missing-project-root") {
    return `${violation.filePath}: declares Glob/Grep but never mentions project_root`;
  }
  return `${violation.filePath}: derives the root itself (${violation.derivation})`;
}

export function checkAgentContext(agentsDirectory: string): AgentContextCheckReport {
  if (!isDirectory(agentsDirectory)) {
    throw new CipherpolAdmissionError(
      "INVALID_AGENT_CONTEXT",
      "Required flat agents view is missing or is not a directory",
      { agentsDirectory, reason: "missing-agents-view" },
    );
  }

  const files = new Map<string, Buffer>();
  for (const fileName of readdirSync(agentsDirectory)) {
    const filePath = join(agentsDirectory, fileName);
    if (lstatSync(filePath).isSymbolicLink()) {
      throw new CipherpolAdmissionError(
        "INVALID_AGENT_CONTEXT",
        `Symbolic links are not allowed in the flat agents view: ${fileName}`,
        { agentsDirectory, filePath: fileName, reason: "symbolic-link" },
      );
    }
    if (fileName.endsWith(".md") && isFile(filePath)) {
      files.set(fileName, readFileSync(filePath));
    }
  }

  return checkAgentContextFromFiles(files, agentsDirectory);
}


/** Reproduces the shipping Working Context gate against a built flat agents/ view. */
export function checkAgentContextFromFiles(
  files: ReadonlyMap<string, Buffer>,
  agentsDirectory: string,
): AgentContextCheckReport {
  const agentFiles = [...files.keys()]
    .filter((fileName) => !fileName.includes("/") && fileName.endsWith(".md"))
    .sort(compareStrings);
  const missing: AgentContextViolation[] = [];
  const derived: AgentContextViolation[] = [];
  let searchAgentsChecked = 0;
  let waivedSearchAgents = 0;
  let pendingSearchAgents = 0;

  for (const fileName of agentFiles) {
    const body = files.get(fileName)!.toString("utf8");
    const agentName = fileName.slice(0, -3);
    const enforced = ENFORCED_AGENT_PREFIXES.some((prefix) => fileName.startsWith(prefix));

    if (enforced) {
      for (const derivation of FORBIDDEN_AGENT_ROOT_DERIVATIONS) {
        if (body.includes(derivation)) {
          derived.push({
            kind: "forbidden-root-derivation",
            agentName,
            filePath: fileName,
            derivation,
          });
        }
      }
    }

    const declaredTools = parseCommaSeparatedLine(body, AGENT_TOOLS_PATTERN);
    if (
      declaredTools === undefined ||
      !SEARCH_AGENT_TOOLS.some((tool) => declaredTools.has(tool))
    ) {
      continue;
    }

    const hasProjectRoot = body.includes("project_root");
    const hasWaiver = AGENT_CONTEXT_WAIVER_PATTERN.test(body);
    if (!enforced) {
      if (!hasProjectRoot && !hasWaiver) {
        pendingSearchAgents += 1;
      }
      continue;
    }

    searchAgentsChecked += 1;
    if (hasWaiver) {
      waivedSearchAgents += 1;
    } else if (!hasProjectRoot) {
      missing.push({ kind: "missing-project-root", agentName, filePath: fileName });
    }
  }

  const violations = [...missing, ...derived];
  if (violations.length > 0) {
    throw new CipherpolAdmissionError(
      "INVALID_AGENT_CONTEXT",
      `Invalid agent context:\n${violations.map(formatAgentContextViolation).join("\n")}`,
      { agentsDirectory, violations },
    );
  }

  return {
    agentFileCount: agentFiles.length,
    searchAgentsChecked,
    waivedSearchAgents,
    pendingSearchAgents,
  };
}
