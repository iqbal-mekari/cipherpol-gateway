import type { DistilledMemory } from "@kb/core";
import { ensureProject, insertMemory } from "@kb/db";
import { embedDocuments } from "@kb/embeddings";
import { rawLogPath, writeMemoryArtifact } from "./capture.js";

/**
 * Embed + persist typed memories that the HOST has already distilled. Each
 * memory is embedded locally, inserted into Supabase, and written as a markdown
 * artifact under projects/<slug>/logs/<session>/.
 */
export async function storeMemories(
  slug: string,
  sessionId: string,
  memories: DistilledMemory[],
): Promise<string[]> {
  if (memories.length === 0) return [];
  const projectId = await ensureProject(slug);
  const embeddings = await embedDocuments(memories.map((m) => `${m.title}\n${m.content}`));
  const logPath = rawLogPath(slug, sessionId);
  const ids: string[] = [];
  for (let i = 0; i < memories.length; i++) {
    const id = await insertMemory(projectId, sessionId, memories[i]!, embeddings[i]!, logPath);
    await writeMemoryArtifact(slug, sessionId, memories[i]!, id);
    ids.push(id);
  }
  return ids;
}
