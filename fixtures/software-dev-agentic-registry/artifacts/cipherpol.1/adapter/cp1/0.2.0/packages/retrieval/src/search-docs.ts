import { getProjectIdBySlug, searchChunks, getChunksMetadata } from "@kb/db";
import { embedQuery } from "@kb/embeddings";
import { parseRef } from "@kb/core";

export interface SearchDocsOptions {
  ref?: string;
  k?: number;
  docTypes?: string[] | null;
  platform?: string[] | null;
  integration?: string | null;
  status?: string | null;
}

export interface DocHit {
  chunkId: string;
  docId: string;
  title: string;
  docType: string;
  breadcrumb: string;
  score: number;
  content: string;
  platform?: string[];
  integration?: string;
  status?: string;
  url?: string;
  project?: string;
}

export interface SearchDocsResult {
  markdown: string;
  hits: DocHit[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const arr = (v: unknown): string[] | undefined => (Array.isArray(v) ? (v as string[]) : undefined);

/**
 * Documentation search: vector ANN over the docs ref, filtered to markdown +
 * doc_type (reusing search_chunks' language/kinds filters), with
 * platform/integration/status applied in TS from chunk metadata. A larger
 * candidate pool is fetched so post-filtering still returns k results.
 */
export async function searchDocs(
  slug: string,
  query: string,
  opts: SearchDocsOptions = {},
): Promise<SearchDocsResult> {
  const projectId = await getProjectIdBySlug(slug);
  if (!projectId) throw new Error(`Unknown project: ${slug}`);
  const ref = parseRef(opts.ref ?? "docs:latest").raw;
  const k = opts.k ?? 6;

  const queryEmbedding = await embedQuery(query);
  const needsPostFilter = !!(opts.platform?.length || opts.integration || opts.status);
  const pool = needsPostFilter ? Math.max(k * 6, 40) : Math.max(k * 2, 12);

  const raw = await searchChunks({
    project: projectId,
    ref,
    queryEmbedding,
    queryText: query,
    k: pool,
    languages: ["markdown"],
    kinds: opts.docTypes ?? null,
  });

  const meta = await getChunksMetadata(raw.map((h) => h.chunk_id));
  let hits: DocHit[] = raw.map((h) => {
    const m = meta.get(h.chunk_id) ?? {};
    const firstLine = (h.content.split("\n")[0] ?? "").replace(/:\s*$/, "");
    return {
      chunkId: h.chunk_id,
      docId: h.file_path,
      title: str(m.title) ?? h.fqn ?? "(untitled)",
      docType: str(m.doc_type) ?? h.symbol_kind ?? "?",
      breadcrumb: firstLine,
      score: h.score,
      content: h.content,
      platform: arr(m.platform),
      integration: str(m.integration),
      status: str(m.status),
      url: str(m.url),
      project: str(m.project),
    };
  });

  if (opts.platform?.length) hits = hits.filter((d) => (d.platform ?? []).some((p) => opts.platform!.includes(p)));
  if (opts.integration) hits = hits.filter((d) => d.integration === opts.integration);
  if (opts.status) hits = hits.filter((d) => (d.status ?? "active") === opts.status);
  hits = hits.slice(0, k);

  return { markdown: assemble(query, slug, ref, hits), hits };
}

function assemble(query: string, slug: string, ref: string, hits: DocHit[]): string {
  if (hits.length === 0) {
    return `# Docs: "${query}"\n\n_No matching documentation in ${slug} @ ${ref}._`;
  }
  const lines = [`# Docs: "${query}"  ·  ${slug} @ ${ref}`, "", `## Most relevant (${hits.length})`, ""];
  for (const h of hits) {
    const facets = [
      `\`${h.docType}\``,
      h.platform?.length ? `platform: ${h.platform.join("+")}` : null,
      h.integration ? h.integration : null,
      h.status && h.status !== "active" ? `status: ${h.status}` : null,
      `score ${h.score.toFixed(4)}`,
    ]
      .filter(Boolean)
      .join("  ·  ");
    // Body without the breadcrumb prefix line.
    const body = h.content.split("\n").slice(1).join("\n").trim();
    lines.push(`### ${h.title}  ·  ${h.docType}`);
    lines.push(`${h.breadcrumb}  ·  ${facets}`);
    if (h.url) lines.push(`${h.url}`);
    lines.push("");
    lines.push(body.slice(0, 800));
    lines.push("");
  }
  return lines.join("\n");
}
