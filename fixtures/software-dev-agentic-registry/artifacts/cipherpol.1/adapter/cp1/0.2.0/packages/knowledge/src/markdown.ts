import { join } from "node:path";
import type { SymbolNode, EdgeRel, Chunk, ExtractedFile, ChunkMetadata } from "@kb/core";
import { sha256 } from "@kb/core";

const MAX_CHUNK_CHARS = 6000; // ~1500 tokens; split larger symbols
const OVERLAP_LINES = 8;

/** Relationships grouped by edge kind for a single symbol (outgoing only). */
export function relationsFor(symbolKey: string, edges: EdgeRel[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const e of edges) {
    if (e.srcKey !== symbolKey) continue;
    (groups[e.kind] ??= []).push(e.dstFqn ?? "?");
  }
  return groups;
}

/** Repo-relative path of a symbol's markdown file under knowledge/.
 *  Filename is sanitized AND length-capped: Swift test method names can be whole
 *  sentences (>255 chars) which would hit ENAMETOOLONG. Append a short hash so
 *  truncation can't collide two different symbols into one file. */
export function knowledgeRelPath(symbol: SymbolNode): string {
  const safe = symbol.fqn.replace(/[^a-zA-Z0-9._-]/g, "_");
  const hash = sha256(symbol.fqn).slice(0, 8);
  const capped = safe.length > 160 ? `${safe.slice(0, 152)}_${hash}` : safe;
  return join(symbol.language, `${capped}.md`);
}

/** The text that gets embedded (code-centric, not the whole md file).
 *  includeSource=true adds the full symbol body — better semantic coverage but
 *  ~85% larger chunks; use for small projects or when storage is not a concern. */
function embeddingText(symbol: SymbolNode, includeSource: boolean): string {
  const parts = [symbol.fqn];
  if (symbol.signature) parts.push(symbol.signature);
  if (symbol.docComment) parts.push(symbol.docComment);
  if (includeSource) parts.push(symbol.source);
  return parts.filter(Boolean).join("\n");
}

function splitOversize(content: string, fqn: string, signature?: string): string[] {
  if (content.length <= MAX_CHUNK_CHARS) return [content];
  const lines = content.split("\n");
  const linesPerChunk = Math.max(20, Math.floor((lines.length * MAX_CHUNK_CHARS) / content.length));
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += linesPerChunk - OVERLAP_LINES) {
    const window = lines.slice(i, i + linesPerChunk).join("\n");
    out.push(window);
    if (i + linesPerChunk >= lines.length) break;
  }
  const n = out.length;
  return out.map((c, k) => `// ${fqn} (part ${k + 1}/${n})\n${signature ?? ""}\n${c}`);
}

/** Build embedding chunks for a file (one per symbol; oversized symbols split).
 *  includeSource controls whether the full symbol body is included in chunk text. */
export function buildChunks(
  file: ExtractedFile,
  project: string,
  commit?: string,
  includeSource = false,
): Chunk[] {
  const chunks: Chunk[] = [];
  for (const s of file.symbols) {
    if (s.kind === "module") continue; // module symbol is a graph anchor, not embedded
    const text = embeddingText(s, includeSource);
    const parts = splitOversize(text, s.fqn, s.signature);
    parts.forEach((content, idx) => {
      const metadata: ChunkMetadata = {
        project,
        file_path: file.path,
        language: s.language,
        symbol_kind: s.kind,
        fqn: s.fqn,
        line_range: [s.startLine, s.endLine],
        commit_sha: commit,
        is_exported: s.isExported,
      };
      chunks.push({
        symbolKey: s.key,
        chunkIndex: idx,
        content,
        contentHash: sha256(content),
        metadata,
      });
    });
  }
  return chunks;
}

/** Render the human/agent-readable markdown file for a symbol (frontmatter + summary + source). */
export function renderSymbolMarkdown(
  symbol: SymbolNode,
  edges: EdgeRel[],
  project: string,
  commit?: string,
): string {
  const rel = relationsFor(symbol.key, edges);
  const fence = symbol.language === "python" ? "python" : "typescript";
  const summary =
    (symbol.docComment ? stripComment(symbol.docComment) + " " : "") +
    `\`${symbol.fqn}\` is a ${symbol.kind} defined in ${symbol.filePath}.`;

  const fm: string[] = [
    "---",
    `project: ${project}`,
    `fqn: ${symbol.fqn}`,
    `name: ${symbol.name}`,
    `kind: ${symbol.kind}`,
    `language: ${symbol.language}`,
    `file: ${symbol.filePath}`,
    `lines: [${symbol.startLine + 1}, ${symbol.endLine + 1}]`,
    `is_exported: ${symbol.isExported}`,
    `content_hash: ${symbol.contentHash}`,
  ];
  if (symbol.signature) fm.push(`signature: ${JSON.stringify(symbol.signature)}`);
  if (commit) fm.push(`commit: ${commit}`);
  for (const [kind, targets] of Object.entries(rel)) {
    fm.push(`${kind}: [${[...new Set(targets)].join(", ")}]`);
  }
  fm.push("---");

  return [
    fm.join("\n"),
    "",
    `## ${symbol.name}`,
    "",
    summary,
    "",
    "### Source",
    "",
    "```" + fence,
    symbol.source,
    "```",
    "",
  ].join("\n");
}

function stripComment(c: string): string {
  return c
    .replace(/^\s*\/\*\*?|\*\/\s*$/g, "")
    .replace(/^\s*\*\s?/gm, "")
    .replace(/^\s*\/\/\s?/gm, "")
    .replace(/^\s*#\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
