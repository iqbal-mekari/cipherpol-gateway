import { sha256 } from "@kb/core";
import type { DocChunk, DocChunkMetadata, DocFrontmatter } from "./types.js";

const MAX_CHUNK_CHARS = 6000; // ~1500 tokens, mirrors the code chunker; hard split above this
const TARGET_CHUNK_CHARS = 2000; // merge adjacent small sections up to this
const OVERLAP_LINES = 6;

/** Longest common breadcrumb prefix (by `>`-separated segments). Always keeps at
 *  least the title. Used when several small sections merge into one chunk. */
function commonBreadcrumb(breadcrumbs: string[]): string {
  const paths = breadcrumbs.map((b) => b.split(" > "));
  const first = paths[0]!;
  let n = first.length;
  for (const p of paths) {
    let i = 0;
    while (i < n && i < p.length && p[i] === first[i]) i++;
    n = i;
  }
  return first.slice(0, Math.max(1, n)).join(" > ");
}

interface Section {
  breadcrumb: string;
  text: string;
  startLine: number;
  endLine: number;
}

/**
 * Split a markdown body into heading-scoped sections. Boundaries are H1/H2
 * headings (docs in this corpus use either as section markers); H3+ stay within
 * their section. Each section carries a breadcrumb `Title > H1 > H2` which is
 * prepended to the embedding text — a large recall win for prose.
 */
export function sectionize(body: string, title: string): Section[] {
  const lines = body.split("\n");
  const cutSet = new Set<number>([0]);
  lines.forEach((l, i) => {
    if (/^#{1,2}\s+\S/.test(l)) cutSet.add(i);
  });
  const cuts = [...cutSet].sort((a, b) => a - b);

  const sections: Section[] = [];
  let currentH1 = "";
  for (let c = 0; c < cuts.length; c++) {
    const start = cuts[c]!;
    const end = c + 1 < cuts.length ? cuts[c + 1]! : lines.length;
    const seg = lines.slice(start, end);
    const text = seg.join("\n").trim();
    if (!text) continue;

    let breadcrumb = title;
    const head = (seg[0] ?? "").match(/^(#{1,2})\s+(.*)$/);
    if (head) {
      const level = head[1]!.length;
      const htext = head[2]!.trim();
      if (level === 1) {
        currentH1 = htext;
        breadcrumb = `${title} > ${htext}`;
      } else {
        breadcrumb = currentH1 ? `${title} > ${currentH1} > ${htext}` : `${title} > ${htext}`;
      }
    }
    sections.push({ breadcrumb, text, startLine: start, endLine: end - 1 });
  }
  return sections;
}

function splitOversize(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const lines = text.split("\n");
  const perChunk = Math.max(20, Math.floor((lines.length * MAX_CHUNK_CHARS) / text.length));
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += perChunk - OVERLAP_LINES) {
    out.push(lines.slice(i, i + perChunk).join("\n"));
    if (i + perChunk >= lines.length) break;
  }
  return out;
}

/** Build embedding chunks for one document. */
export function buildDocChunks(body: string, fm: DocFrontmatter): DocChunk[] {
  const baseMeta: Omit<DocChunkMetadata, "line_range"> = {
    source_type: "doc",
    file_path: fm.doc_id,
    language: "markdown",
    symbol_kind: fm.doc_type, // reuse code path's `kinds` filter
    fqn: fm.title,
    doc_type: fm.doc_type,
    doc_source: fm.source,
    title: fm.title,
    projects: fm.projects,
    platform: fm.platform,
    integration: fm.integration,
    status: fm.status,
    tags: fm.tags,
    url: fm.url,
    related_symbols: fm.related_symbols,
  };

  // Greedy-pack adjacent sections up to TARGET so many tiny single-heading
  // sections don't each become their own (poorly-embedding) chunk.
  const sections = sectionize(body, fm.title);
  const groups: (typeof sections)[] = [];
  let cur: typeof sections = [];
  let curLen = 0;
  for (const s of sections) {
    if (cur.length > 0 && curLen + s.text.length + 2 > TARGET_CHUNK_CHARS) {
      groups.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(s);
    curLen += s.text.length + 2;
  }
  if (cur.length) groups.push(cur);

  const chunks: DocChunk[] = [];
  let idx = 0;
  for (const g of groups) {
    const breadcrumb = commonBreadcrumb(g.map((s) => s.breadcrumb));
    const lineRange: [number, number] = [g[0]!.startLine, g[g.length - 1]!.endLine];
    const pieces = splitOversize(g.map((s) => s.text).join("\n\n")); // large single section still splits
    pieces.forEach((piece, k) => {
      const bc = pieces.length > 1 ? `${breadcrumb} (part ${k + 1}/${pieces.length})` : breadcrumb;
      const content = `${bc}:\n\n${piece}`;
      chunks.push({
        chunkIndex: idx++,
        breadcrumb: bc,
        content,
        contentHash: sha256(content),
        lineRange,
        metadata: { ...baseMeta, line_range: lineRange },
      });
    });
  }
  return chunks;
}
