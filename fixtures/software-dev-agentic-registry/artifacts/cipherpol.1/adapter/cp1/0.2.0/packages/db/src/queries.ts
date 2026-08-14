import { db } from "./client.js";

/** Row shapes returned by the retrieval RPCs (see supabase/migrations/0002_functions.sql). */
export interface SearchHit {
  chunk_id: string;
  symbol_id: string | null;
  file_path: string;
  fqn: string | null;
  language: string | null;
  symbol_kind: string | null;
  line_range: [number, number] | null;
  content: string;
  score: number;
}

export interface GraphNode {
  symbol_id: string;
  fqn: string;
  kind: string;
  file_path: string;
  hop: number;
  via_edge: string | null;
  from_symbol: string | null;
}

export interface ImpactNode {
  symbol_id: string;
  fqn: string;
  kind: string;
  file_path: string;
  depth: number;
}

export interface MemoryHit {
  id: string;
  kind: string;
  title: string | null;
  content: string;
  session_id: string;
  created_at: string;
  score: number;
}

export interface SearchChunksArgs {
  project: string;
  ref: string;
  queryEmbedding: number[];
  queryText: string;
  languages?: string[] | null;
  pathPrefix?: string | null;
  kinds?: string[] | null;
  k?: number;
  efSearch?: number;
}

export async function searchChunks(a: SearchChunksArgs): Promise<SearchHit[]> {
  const { data, error } = await db().rpc("search_chunks", {
    p_project: a.project,
    p_ref: a.ref,
    p_query_embedding: a.queryEmbedding,
    p_query_text: a.queryText,
    p_languages: a.languages ?? null,
    p_path_prefix: a.pathPrefix ?? null,
    p_kinds: a.kinds ?? null,
    p_k: a.k ?? 20,
    // HNSW scans the global top-ef candidates BEFORE the project/ref filter is
    // applied. At 100 (the SQL default) a ref's rows can be entirely crowded
    // out once several similar projects/refs share the index — returning 0
    // hits for a fully-indexed project. 800 keeps recall at current corpus
    // size; migration 0004 (hnsw.iterative_scan) is the durable fix.
    p_ef_search: a.efSearch ?? Number(process.env.KB_SEARCH_EF_SEARCH ?? 800),
  });
  if (error) throw new Error(`search_chunks: ${error.message}`);
  return (data ?? []) as SearchHit[];
}

export async function expandGraph(
  project: string,
  ref: string,
  seedSymbols: string[],
  maxHops = 2,
  kinds?: string[] | null,
): Promise<GraphNode[]> {
  if (seedSymbols.length === 0) return [];
  const { data, error } = await db().rpc("expand_graph", {
    p_project: project,
    p_ref: ref,
    p_seed_symbols: seedSymbols,
    p_max_hops: maxHops,
    p_kinds: kinds ?? null,
  });
  if (error) throw new Error(`expand_graph: ${error.message}`);
  return (data ?? []) as GraphNode[];
}

export async function impact(
  project: string,
  ref: string,
  symbolId: string,
  maxDepth = 3,
): Promise<ImpactNode[]> {
  const { data, error } = await db().rpc("impact", {
    p_project: project,
    p_ref: ref,
    p_symbol: symbolId,
    p_max_depth: maxDepth,
  });
  if (error) throw new Error(`impact: ${error.message}`);
  return (data ?? []) as ImpactNode[];
}

export interface RecallArgs {
  project: string;
  queryEmbedding: number[];
  queryText: string;
  session?: string | null;
  kinds?: string[] | null;
  k?: number;
}

export async function recallMemories(a: RecallArgs): Promise<MemoryHit[]> {
  const { data, error } = await db().rpc("recall_memories", {
    p_project: a.project,
    p_query_embedding: a.queryEmbedding,
    p_query_text: a.queryText,
    p_session: a.session ?? null,
    p_kinds: a.kinds ?? null,
    p_k: a.k ?? 10,
  });
  if (error) throw new Error(`recall_memories: ${error.message}`);
  return (data ?? []) as MemoryHit[];
}

export interface SymbolRow {
  id: string;
  ref: string;
  fqn: string;
  name: string;
  kind: string;
  language: string;
  signature: string | null;
  doc_comment: string | null;
  source_text: string | null;
  start_line: number;
  end_line: number;
  is_exported: boolean;
  file_path?: string;
  /** Last commit that touched this symbol's file (see @kb/extractor's fileProvenance). */
  last_commit_hash?: string | null;
  last_commit_author?: string | null;
  last_commit_date?: string | null;
  last_commit_subject?: string | null;
}

/** Fetch a symbol by id, or by fqn within a ref (fqn returns the first match). Joins file path. */
export async function getSymbol(
  project: string,
  by: { id?: string; fqn?: string; ref?: string },
): Promise<SymbolRow | null> {
  let q = db()
    .from("symbols")
    .select(
      "id,ref,fqn,name,kind,signature,doc_comment,source_text,start_line,end_line,is_exported,files(path,language,last_commit_hash,last_commit_author,last_commit_date,last_commit_subject)",
    )
    .eq("project_id", project);
  if (by.id) q = q.eq("id", by.id);
  else if (by.fqn) {
    q = q.eq("fqn", by.fqn);
    if (by.ref) q = q.eq("ref", by.ref);
  } else return null;
  const { data, error } = await q.limit(1).maybeSingle();
  if (error) throw new Error(`getSymbol: ${error.message}`);
  if (!data) return null;
  const fileRel = (
    data as {
      files?: {
        path?: string;
        language?: string;
        last_commit_hash?: string | null;
        last_commit_author?: string | null;
        last_commit_date?: string | null;
        last_commit_subject?: string | null;
      };
    }
  ).files;
  return {
    ...(data as unknown as SymbolRow),
    language: fileRel?.language ?? "",
    file_path: fileRel?.path,
    last_commit_hash: fileRel?.last_commit_hash ?? null,
    last_commit_author: fileRel?.last_commit_author ?? null,
    last_commit_date: fileRel?.last_commit_date ?? null,
    last_commit_subject: fileRel?.last_commit_subject ?? null,
  };
}

export interface NeighborRow {
  symbol_id: string;
  fqn: string;
  kind: string;
  file_path: string;
  edge_kind: string;
  direction: "out" | "in";
}

/** One-hop neighbors of a symbol, grouped by direction (callers vs callees). */
export async function getNeighbors(
  project: string,
  symbolId: string,
): Promise<NeighborRow[]> {
  const client = db();
  const out: NeighborRow[] = [];

  const { data: outgoing, error: e1 } = await client
    .from("edges")
    .select("kind,dst:symbols!edges_dst_symbol_id_fkey(id,fqn,kind,files(path))")
    .eq("project_id", project)
    .eq("src_symbol_id", symbolId)
    .not("dst_symbol_id", "is", null);
  if (e1) throw new Error(`getNeighbors out: ${e1.message}`);
  for (const r of outgoing ?? []) {
    const row = r as unknown as { kind: string; dst?: { id: string; fqn: string; kind: string; files?: { path?: string } } };
    const d = row.dst;
    if (d) out.push({ symbol_id: d.id, fqn: d.fqn, kind: d.kind, file_path: d.files?.path ?? "", edge_kind: row.kind, direction: "out" });
  }

  const { data: incoming, error: e2 } = await client
    .from("edges")
    .select("kind,src:symbols!edges_src_symbol_id_fkey(id,fqn,kind,files(path))")
    .eq("project_id", project)
    .eq("dst_symbol_id", symbolId);
  if (e2) throw new Error(`getNeighbors in: ${e2.message}`);
  for (const r of incoming ?? []) {
    const row = r as unknown as { kind: string; src?: { id: string; fqn: string; kind: string; files?: { path?: string } } };
    const s = row.src;
    if (s) out.push({ symbol_id: s.id, fqn: s.fqn, kind: s.kind, file_path: s.files?.path ?? "", edge_kind: row.kind, direction: "in" });
  }
  return out;
}

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  updated_at: string;
}

export async function listProjects(): Promise<ProjectRow[]> {
  const { data, error } = await db()
    .from("projects")
    .select("id,slug,name,updated_at")
    .order("slug");
  if (error) throw new Error(`listProjects: ${error.message}`);
  return (data ?? []) as ProjectRow[];
}

export interface RefRow {
  ref: string;
  files: number;
}

/** Distinct refs indexed for a project (from the files table). */
export async function listRefs(projectId: string): Promise<string[]> {
  const { data, error } = await db().from("files").select("ref").eq("project_id", projectId);
  if (error) throw new Error(`listRefs: ${error.message}`);
  return [...new Set((data ?? []).map((r) => r.ref as string))].sort();
}

/** Fetch metadata jsonb for a set of chunk ids (batched to avoid 414 URLs).
 *  Used by doc search to filter/render on fields search_chunks doesn't return. */
export async function getChunksMetadata(
  ids: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  if (ids.length === 0) return map;
  const BATCH = 100;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const { data, error } = await db().from("chunks").select("id,metadata").in("id", batch);
    if (error) throw new Error(`getChunksMetadata: ${error.message}`);
    for (const r of data ?? []) map.set(r.id as string, (r.metadata ?? {}) as Record<string, unknown>);
  }
  return map;
}

export interface DocChunkRow {
  id: string;
  ref: string;
  content: string;
  metadata: Record<string, unknown>;
}

/** Doc chunks whose metadata.related_symbols contains `fqn` (jsonb @> containment,
 *  accelerated by chunks_meta_gin). The reverse doc↔code link: "which docs
 *  document this code symbol". Cross-ref by design (docs ref vs code ref). */
export async function findDocChunksByRelatedSymbol(
  projectId: string,
  fqn: string,
): Promise<DocChunkRow[]> {
  const { data, error } = await db()
    .from("chunks")
    .select("id,ref,content,metadata")
    .eq("project_id", projectId)
    .contains("metadata", { related_symbols: [fqn] });
  if (error) throw new Error(`findDocChunksByRelatedSymbol: ${error.message}`);
  return (data ?? []) as DocChunkRow[];
}

/** Read one chunk's metadata for a given doc_id (metadata.file_path), to recover
 *  a doc's related_symbols / title without re-reading the source file. */
export async function getDocMetaByDocId(
  projectId: string,
  docId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await db()
    .from("chunks")
    .select("metadata")
    .eq("project_id", projectId)
    .filter("metadata->>file_path", "eq", docId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getDocMetaByDocId: ${error.message}`);
  return data ? ((data.metadata ?? {}) as Record<string, unknown>) : null;
}

export interface RefSymbolRow {
  fqn: string;
  name: string;
  kind: string;
  signature: string | null;
  content_hash: string;
  start_line: number;
  end_line: number;
  file_path: string;
}

/**
 * Symbols for a project at a given ref, with enough fields to diff against another
 * ref (see `diffRefs` in @kb/retrieval). Optionally scoped to files whose path
 * starts with `pathPrefix` (filtered client-side — cheaper than a join-filter for
 * the ref-sized result sets this targets).
 */
export async function symbolsForRef(
  projectId: string,
  ref: string,
  pathPrefix?: string | null,
): Promise<RefSymbolRow[]> {
  const { data, error } = await db()
    .from("symbols")
    .select("fqn,name,kind,signature,content_hash,start_line,end_line,files(path)")
    .eq("project_id", projectId)
    .eq("ref", ref);
  if (error) throw new Error(`symbolsForRef: ${error.message}`);
  const rows = (data ?? []) as Array<{
    fqn: string;
    name: string;
    kind: string;
    signature: string | null;
    content_hash: string;
    start_line: number;
    end_line: number;
    files?: { path?: string } | null;
  }>;
  return rows
    .map((r) => ({
      fqn: r.fqn,
      name: r.name,
      kind: r.kind,
      signature: r.signature,
      content_hash: r.content_hash,
      start_line: r.start_line,
      end_line: r.end_line,
      file_path: r.files?.path ?? "",
    }))
    .filter((r) => !pathPrefix || r.file_path.startsWith(pathPrefix));
}

/** Touch last_used_at for memories that were just surfaced (usefulness signal). */
export async function touchMemories(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await db()
    .from("memories")
    .update({ last_used_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw new Error(`touchMemories: ${error.message}`);
}
