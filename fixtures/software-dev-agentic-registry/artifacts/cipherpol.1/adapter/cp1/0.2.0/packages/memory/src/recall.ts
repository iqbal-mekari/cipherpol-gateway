import { getProjectIdBySlug, recallMemories, touchMemories, type MemoryHit } from "@kb/db";
import { embedQuery } from "@kb/embeddings";
import type { MemoryKind } from "@kb/core";

export interface RecallOptions {
  session?: string | null;
  kinds?: MemoryKind[] | null;
  k?: number;
}

export interface RecallResult {
  markdown: string;
  hits: MemoryHit[];
}

/**
 * Recall durable memories for a project, ranked by relevance + recency.
 * Project scope is enforced in the RPC — memories never leak across projects.
 */
export async function recall(slug: string, query: string, opts: RecallOptions = {}): Promise<RecallResult> {
  const projectId = await getProjectIdBySlug(slug);
  if (!projectId) throw new Error(`Unknown project: ${slug}`);

  const queryEmbedding = await embedQuery(query);
  const hits = await recallMemories({
    project: projectId,
    queryEmbedding,
    queryText: query,
    session: opts.session,
    kinds: opts.kinds,
    k: opts.k ?? 8,
  });

  // Usefulness signal: bump last_used_at for what we surfaced.
  await touchMemories(hits.map((h) => h.id));

  return { markdown: assemble(slug, query, hits), hits };
}

function assemble(slug: string, query: string, hits: MemoryHit[]): string {
  if (hits.length === 0) return `# Memories for ${slug}: "${query}"\n\n_No relevant memories yet._`;
  const lines = [`# Memories for ${slug}: "${query}"`, ""];
  for (const h of hits) {
    const when = h.created_at.slice(0, 10);
    lines.push(`### [${h.kind}] ${h.title ?? "(untitled)"}`);
    lines.push(`_${when} · session ${h.session_id} · score ${h.score.toFixed(3)}_`);
    lines.push("");
    lines.push(h.content);
    lines.push("");
  }
  return lines.join("\n");
}
