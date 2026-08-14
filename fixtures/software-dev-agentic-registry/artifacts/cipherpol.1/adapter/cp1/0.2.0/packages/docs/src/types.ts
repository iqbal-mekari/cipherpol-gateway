/**
 * Types + controlled vocabularies for the documentation ingestion pipeline.
 * See docs/doc-source-ingestion/frontmatter-spec.md for the authoritative spec.
 */

export const DOC_TYPES = [
  "prd", "rfc", "adr", "standard", "guide", "runbook", "design", "spec", "reference", "other",
] as const;
export const SOURCES = ["confluence", "local", "notion"] as const;
export const PLATFORMS = ["flutter", "ios", "android", "web", "backend", "shared"] as const;
export const INTEGRATIONS = ["standalone", "embedded"] as const;
export const STATUSES = ["draft", "active", "deprecated", "superseded"] as const;

export type DocType = (typeof DOC_TYPES)[number];
export type Platform = (typeof PLATFORMS)[number];
export type Integration = (typeof INTEGRATIONS)[number];
export type DocStatus = (typeof STATUSES)[number];

/** Sentinel project for docs with no explicit project affiliation. */
export const GLOBAL_PROJECT = "_global";

/** Parsed + validated frontmatter of one normalized artifact. */
export interface DocFrontmatter {
  title: string;
  doc_type: DocType;
  projects: string[];
  platform?: Platform[];
  integration?: Integration;
  ref: string;
  source: string;
  doc_id: string;
  status: DocStatus;
  tags?: string[];
  url?: string;
  space?: string;
  version?: string;
  content_hash?: string;
  fetched_at?: string;
  updated_at?: string;
  owner?: string;
  related_symbols?: string[];
}

/** Metadata written to chunks.metadata (jsonb). Mirrors the code path's shape,
 *  reusing `language`/`symbol_kind` so the existing search_chunks filters work. */
export interface DocChunkMetadata {
  source_type: "doc";
  file_path: string; // doc_id
  language: "markdown"; // reuses search_chunks `languages` filter
  symbol_kind: string; // = doc_type; reuses search_chunks `kinds` filter
  fqn: string; // = title
  doc_type: string;
  doc_source: string; // local | confluence | …
  title: string;
  projects: string[];
  platform?: string[];
  integration?: string;
  status: string;
  tags?: string[];
  url?: string;
  /** Code symbol fqns this doc documents — resolved at query time (cross-ref). */
  related_symbols?: string[];
  line_range: [number, number];
}

/** One embedding unit: a heading-scoped section (oversize sections split). */
export interface DocChunk {
  chunkIndex: number;
  breadcrumb: string;
  content: string; // breadcrumb + section body — the embedding input
  contentHash: string;
  lineRange: [number, number];
  metadata: DocChunkMetadata;
}

/** A fully processed artifact: validated frontmatter + chunks + any warnings. */
export interface DocFile {
  path: string; // absolute fs path
  relPath: string; // relative to the corpus root
  frontmatter: DocFrontmatter;
  body: string;
  chunks: DocChunk[];
  warnings: string[];
}
