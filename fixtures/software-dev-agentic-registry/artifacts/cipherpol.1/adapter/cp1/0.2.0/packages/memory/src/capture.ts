import { appendFile, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { config, type DistilledMemory } from "@kb/core";

/** Directory holding everything for one session: projects/<slug>/logs/<session>/. */
export function sessionDir(slug: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(config.projectsRoot(), slug, "logs", safe);
}

/** Raw, append-only episodic log for a session. */
export function rawLogPath(slug: string, sessionId: string): string {
  return join(sessionDir(slug, sessionId), "raw.md");
}

/**
 * Append a raw entry to the session log (lossless episodic tier). No LLM.
 * Distillation into durable memories is done by the host via MCP + a skill.
 */
export async function captureRaw(slug: string, sessionId: string, entry: string): Promise<string> {
  const path = rawLogPath(slug, sessionId);
  await mkdir(sessionDir(slug, sessionId), { recursive: true });
  await appendFile(path, `\n${entry.trim()}\n`, "utf8");
  return path;
}

/** Remove a session's on-disk directory (raw log + memory artifacts). */
export async function removeSessionDir(slug: string, sessionId: string): Promise<void> {
  await rm(sessionDir(slug, sessionId), { recursive: true, force: true });
}

export async function readLog(slug: string, sessionId: string): Promise<string> {
  try {
    return await readFile(rawLogPath(slug, sessionId), "utf8");
  } catch {
    return "";
  }
}

/** Write a distilled memory as a markdown artifact under the session dir. */
export async function writeMemoryArtifact(
  slug: string,
  sessionId: string,
  m: DistilledMemory,
  id: string,
): Promise<string> {
  const safeTitle = m.title.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 48).replace(/^-|-$/g, "");
  const path = join(sessionDir(slug, sessionId), `${m.kind}-${safeTitle || id.slice(0, 8)}.md`);
  await mkdir(sessionDir(slug, sessionId), { recursive: true });
  const body = [
    "---",
    `id: ${id}`,
    `kind: ${m.kind}`,
    `session: ${sessionId}`,
    `confidence: ${m.confidence ?? 0.5}`,
    "---",
    "",
    `# ${m.title}`,
    "",
    m.content,
    "",
  ].join("\n");
  await writeFile(path, body, "utf8");
  return path;
}
