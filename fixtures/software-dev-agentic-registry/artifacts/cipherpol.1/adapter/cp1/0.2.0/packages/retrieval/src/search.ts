import {
  getProjectIdBySlug,
  searchChunks,
  expandGraph,
  type SearchHit,
  type GraphNode,
} from "@kb/db";
import { embedQuery } from "@kb/embeddings";
import { config, parseRef } from "@kb/core";

export interface SearchOptions {
  ref?: string;
  k?: number;
  expandHops?: number;
  languages?: string[] | null;
  kinds?: string[] | null;
  pathPrefix?: string | null;
}

export interface SearchResult {
  markdown: string;
  hits: SearchHit[];
  neighbors: GraphNode[];
}

/**
 * The core "query like Google" flow:
 *   embed(query) → vector+FTS seed (RRF) → graph-expand seeds → assemble a
 *   connected subgraph of markdown. Seeds get full source cards; graph
 *   neighbors get a one-line relationship label.
 */
export async function search(slug: string, query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const projectId = await getProjectIdBySlug(slug);
  if (!projectId) throw new Error(`Unknown project: ${slug}`);
  const ref = parseRef(opts.ref ?? config.defaultRef()).raw;

  const queryEmbedding = await embedQuery(query);
  const hits = await searchChunks({
    project: projectId,
    ref,
    queryEmbedding,
    queryText: query,
    k: opts.k ?? 8,
    languages: opts.languages,
    kinds: opts.kinds,
    pathPrefix: opts.pathPrefix,
  });

  const seedIds = [...new Set(hits.map((h) => h.symbol_id).filter((x): x is string => !!x))];
  const neighbors = await expandGraph(projectId, ref, seedIds, opts.expandHops ?? 1);

  return { markdown: assemble(query, hits, neighbors), hits, neighbors };
}

function assemble(query: string, hits: SearchHit[], neighbors: GraphNode[]): string {
  if (hits.length === 0) {
    return `# Search: "${query}"\n\n_No results. The project may not be indexed, or embeddings are missing._`;
  }
  const seedFqns = new Set(hits.map((h) => h.fqn).filter(Boolean));
  const lines: string[] = [`# Search: "${query}"`, "", `## Most relevant (${hits.length})`, ""];

  for (const h of hits) {
    const loc = h.line_range ? `${h.file_path}:${h.line_range[0] + 1}-${h.line_range[1] + 1}` : h.file_path;
    lines.push(`### ${h.fqn ?? "(file-level)"}  ·  \`${h.symbol_kind ?? "?"}\``);
    lines.push(`${loc}  ·  score ${h.score.toFixed(4)}`);
    lines.push("");
    lines.push("```" + (h.language ?? ""));
    lines.push(h.content.trimEnd());
    lines.push("```");
    lines.push("");
  }

  const related = neighbors.filter((n) => n.hop > 0 && !seedFqns.has(n.fqn));
  if (related.length > 0) {
    lines.push("## Related (graph-expanded)", "");
    for (const n of dedupeNeighbors(related)) {
      lines.push(`- \`${n.via_edge ?? "→"}\` **${n.fqn}** (${n.kind}) — ${n.file_path} _[hop ${n.hop}]_`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function dedupeNeighbors(ns: GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  const out: GraphNode[] = [];
  for (const n of ns.sort((a, b) => a.hop - b.hop)) {
    if (seen.has(n.fqn)) continue;
    seen.add(n.fqn);
    out.push(n);
  }
  return out;
}
