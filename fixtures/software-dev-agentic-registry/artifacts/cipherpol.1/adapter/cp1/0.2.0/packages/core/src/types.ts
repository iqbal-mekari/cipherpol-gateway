/**
 * Shared domain types for the knowledge-base pipeline. These mirror the
 * Supabase schema (supabase/migrations/0001_schema.sql) but represent the
 * in-memory shape produced by extraction before persistence.
 */

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "module";

export type EdgeKind =
  | "calls"
  | "imports"
  | "extends"
  | "implements"
  | "references"
  | "returns";

export type MemoryKind = "decision" | "fact" | "pattern" | "todo" | "gotcha";

/** A code entity extracted by tree-sitter. */
export interface SymbolNode {
  /** Stable identity within a project = hash(file_path + fqn). Lines are NOT part of identity. */
  key: string;
  fqn: string;
  name: string;
  kind: SymbolKind;
  language: string;
  filePath: string;
  signature?: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  /** Leading doc comment block, if any. */
  docComment?: string;
  /** Verbatim source slice for this symbol. */
  source: string;
  /** sha256(source) — gates embedding; whitespace-only line moves don't churn it. */
  contentHash: string;
  isExported: boolean;
}

/** A directed relationship between two symbols. dst may be unresolved at parse time. */
export interface EdgeRel {
  srcKey: string;
  /** Resolved target symbol key, or undefined when only the raw name is known. */
  dstKey?: string;
  /** Raw target name when unresolved (stdlib / third-party / forward ref). */
  dstFqn?: string;
  kind: EdgeKind;
}

/** Result of parsing+extracting a single file. */
export interface ExtractedFile {
  path: string;
  language: string;
  contentHash: string;
  loc: number;
  sizeBytes: number;
  symbols: SymbolNode[];
  edges: EdgeRel[];
}

/** An embedding unit. One per symbol; oversized symbols split into chunkIndex 0..N. */
export interface Chunk {
  symbolKey?: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  metadata: ChunkMetadata;
}

export interface ChunkMetadata {
  project: string;
  file_path: string;
  language: string;
  symbol_kind?: SymbolKind;
  fqn?: string;
  line_range?: [number, number];
  commit_sha?: string;
  is_exported?: boolean;
  /** For merged tiny-symbol chunks. */
  fqns?: string[];
}

export interface DistilledMemory {
  kind: MemoryKind;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  confidence?: number;
}
