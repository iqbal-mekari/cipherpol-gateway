import { randomUUID } from "node:crypto";
import { db } from "./client.js";
import type { ExtractedFile, SymbolNode, EdgeRel, Chunk, DistilledMemory } from "@kb/core";

/**
 * Retry a DB op on transient errors. Concurrent file persistence can hit
 * Postgres deadlocks (cascade deletes touching overlapping index locks);
 * retrying resolves them. Also retries on the common 502 "Bad Gateway" gateway
 * hiccup from the REST layer.
 */
async function retryDb<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const transient = /deadlock|could not serialize|Bad Gateway|502|FetchError|fetch failed|ECONNRESET|ETIMEDOUT/i.test(msg);
      if (!transient || i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 250 * 2 ** i + Math.random() * 200));
    }
  }
}

/** Get a project by slug, or create it. Returns the project id. */
export async function ensureProject(slug: string, name?: string): Promise<string> {
  const client = db();
  const { data: existing, error: selErr } = await client
    .from("projects")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (selErr) throw new Error(`ensureProject select: ${selErr.message}`);
  if (existing) return existing.id as string;

  const { data, error } = await client
    .from("projects")
    .insert({ slug, name: name ?? slug })
    .select("id")
    .single();
  if (error) throw new Error(`ensureProject insert: ${error.message}`);
  return data.id as string;
}

/**
 * Delete an entire project and all its data. Child tables are deleted in small
 * batches first — a single cascading DELETE FROM projects times out on large
 * repos (tens of thousands of chunks). Returns true if the project existed.
 */
export async function deleteProject(slug: string): Promise<boolean> {
  const client = db();
  const { data: proj } = await client.from("projects").select("id").eq("slug", slug).maybeSingle();
  if (!proj) return false;
  const id = proj.id as string;

  for (const t of ["chunks", "edges", "symbols", "files", "memories", "skills"]) {
    for (;;) {
      const { data, error } = await client.from(t).select("id").eq("project_id", id).limit(500);
      if (error) throw new Error(`deleteProject ${t} select: ${error.message}`);
      if (!data || data.length === 0) break;
      const ids = data.map((r) => r.id);
      const { error: delErr } = await client.from(t).delete().in("id", ids).eq("project_id", id);
      if (delErr) throw new Error(`deleteProject ${t} delete: ${delErr.message}`);
    }
  }

  const { error } = await client.from("projects").delete().eq("id", id);
  if (error) throw new Error(`deleteProject project: ${error.message}`);
  return true;
}

/** Delete one ref (snapshot) of a project: files for the ref cascade to symbols/edges/chunks. Returns files removed. */
export async function deleteRef(projectId: string, ref: string): Promise<number> {
  const { count, error } = await db()
    .from("files")
    .delete({ count: "exact" })
    .eq("project_id", projectId)
    .eq("ref", ref);
  if (error) throw new Error(`deleteRef: ${error.message}`);
  return count ?? 0;
}

/**
 * Delete memories for a project. Scope: a single id, a whole session, or
 * (when neither is given) ALL memories for the project. Returns the count.
 */
export async function deleteMemories(
  projectId: string,
  opts: { id?: string; session?: string },
): Promise<number> {
  let q = db().from("memories").delete({ count: "exact" }).eq("project_id", projectId);
  if (opts.id) q = q.eq("id", opts.id);
  else if (opts.session) q = q.eq("session_id", opts.session);
  const { count, error } = await q;
  if (error) throw new Error(`deleteMemories: ${error.message}`);
  return count ?? 0;
}

export async function getProjectIdBySlug(slug: string): Promise<string | null> {
  const { data, error } = await db()
    .from("projects")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(`getProjectIdBySlug: ${error.message}`);
  return data ? (data.id as string) : null;
}

/** Last commit that touched a file — see @kb/extractor's fileProvenance (structurally
 *  compatible; not imported directly to avoid a db→extractor package dependency). */
export interface FileProvenance {
  commitHash: string;
  author: string;
  date: string;
  subject: string;
}

/** Upsert a file row for a ref, returning its id. `provenance` (if given) is the
 *  last commit that touched this file (see @kb/extractor's fileProvenance) — stored
 *  alongside, not required for indexing to succeed. */
export async function upsertFile(
  projectId: string,
  ref: string,
  f: Pick<ExtractedFile, "path" | "language" | "contentHash" | "loc" | "sizeBytes">,
  commit?: string,
  provenance?: FileProvenance,
): Promise<string> {
  const { data, error } = await db()
    .from("files")
    .upsert(
      {
        project_id: projectId,
        ref,
        path: f.path,
        language: f.language,
        content_hash: f.contentHash,
        loc: f.loc,
        size_bytes: f.sizeBytes,
        last_indexed_commit: commit ?? null,
        last_commit_hash: provenance?.commitHash ?? null,
        last_commit_author: provenance?.author ?? null,
        last_commit_date: provenance?.date ?? null,
        last_commit_subject: provenance?.subject ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "project_id,ref,path" },
    )
    .select("id")
    .single();
  if (error) throw new Error(`upsertFile(${f.path}): ${error.message}`);
  return data.id as string;
}

/**
 * Replace all symbols for a file: delete the file's existing symbols (cascading
 * to their chunks + outgoing edges via FK), then insert the fresh set.
 * Returns a map of symbolKey -> db symbol id for edge resolution.
 */
export async function replaceSymbols(
  projectId: string,
  ref: string,
  fileId: string,
  symbols: SymbolNode[],
): Promise<Map<string, string>> {
  const client = db();
  await retryDb(async () => {
    const r = await client.from("symbols").delete().eq("file_id", fileId);
    if (r.error) throw new Error(`replaceSymbols delete: ${r.error.message}`);
  });

  const map = new Map<string, string>();
  if (symbols.length === 0) return map;

  // Generate symbol UUIDs client-side so we can build the key→id map WITHOUT
  // depending on the bulk insert's `.select()` returning rows (PostgREST does
  // not reliably return data on multi-row insert in all configs — which left
  // edges unresolvable). We supply `id` explicitly; the column accepts it.
  const rows = symbols.map((s) => {
    const id = randomUUID();
    map.set(s.key, id);
    return {
      id,
      project_id: projectId,
      ref,
      file_id: fileId,
      fqn: s.fqn,
      name: s.name,
      kind: s.kind,
      signature: s.signature ?? null,
      start_line: s.startLine,
      end_line: s.endLine,
      start_byte: s.startByte,
      end_byte: s.endByte,
      content_hash: s.contentHash,
      doc_comment: s.docComment ?? null,
      source_text: s.source || null,
      is_exported: s.isExported,
    };
  });
  // Batch inserts: the fqn_trgm GIN index update can exceed Supabase's 8s
  // statement timeout when a single file has many symbols (large classes).
  const SYM_BATCH = 50;
  for (let i = 0; i < rows.length; i += SYM_BATCH) {
    const batch = rows.slice(i, i + SYM_BATCH);
    await retryDb(async () => {
      const r = await client.from("symbols").insert(batch);
      if (r.error) throw new Error(`replaceSymbols insert: ${r.error.message}`);
    });
  }

  return map;
}

/** Delete-then-insert edges originating in a file. dstKey is resolved via keyToId. */
export async function replaceEdges(
  projectId: string,
  ref: string,
  fileId: string,
  edges: EdgeRel[],
  keyToId: Map<string, string>,
): Promise<void> {
  const client = db();
  await retryDb(async () => {
    const r = await client.from("edges").delete().eq("src_file_id", fileId);
    if (r.error) throw new Error(`replaceEdges delete: ${r.error.message}`);
  });
  if (edges.length === 0) return;

  const rows = edges
    .map((e) => {
      const srcId = keyToId.get(e.srcKey);
      if (!srcId) return null; // src must be a known symbol in this file
      const dstId = e.dstKey ? keyToId.get(e.dstKey) ?? null : null;
      return {
        project_id: projectId,
        ref,
        src_symbol_id: srcId,
        dst_symbol_id: dstId,
        dst_fqn: dstId ? null : e.dstFqn ?? null,
        kind: e.kind,
        src_file_id: fileId,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length === 0) return;
  const EDGE_BATCH = 100;
  for (let i = 0; i < rows.length; i += EDGE_BATCH) {
    const batch = rows.slice(i, i + EDGE_BATCH);
    await retryDb(async () => {
      const r = await client.from("edges").insert(batch);
      if (r.error) throw new Error(`replaceEdges insert: ${r.error.message}`);
    });
  }
}

/**
 * Second-pass cross-file edge resolution: link unresolved edges whose dst_fqn
 * now matches a known symbol. Idempotent.
 */
export async function resolveCrossFileEdges(projectId: string, ref: string): Promise<number> {
  const { data, error } = await db().rpc("resolve_edges", { p_project: projectId, p_ref: ref });
  if (error) throw new Error(`resolveCrossFileEdges: ${error.message}`);
  return (data as number) ?? 0;
}

/** Upsert chunks for a file. Embeddings (by content_hash) are inserted in the same pass. */
export async function replaceChunks(
  projectId: string,
  ref: string,
  fileId: string,
  chunks: Chunk[],
  keyToId: Map<string, string>,
  embeddingsByHash?: Map<string, number[]>,
): Promise<void> {
  const client = db();
  await retryDb(async () => {
    const r = await client.from("chunks").delete().eq("file_id", fileId);
    if (r.error) throw new Error(`replaceChunks delete: ${r.error.message}`);
  });
  if (chunks.length === 0) return;

  const rows = chunks.map((c) => ({
    project_id: projectId,
    ref,
    file_id: fileId,
    symbol_id: c.symbolKey ? keyToId.get(c.symbolKey) ?? null : null,
    chunk_index: c.chunkIndex,
    content: c.content,
    content_hash: c.contentHash,
    embedding: embeddingsByHash?.get(c.contentHash) ?? null,
    metadata: c.metadata,
  }));
  // Insert in small batches: large files (hundreds of chunks with text + jsonb +
  // generated tsvector) can exceed Supabase's ~8s statement timeout in one call.
  // 10 rows keeps tsvector generation + embedding payload well under 8s even on
  // large Kotlin/Java codebases with 30k+ chunks.
  const CHUNK_BATCH = 10;
  for (let i = 0; i < rows.length; i += CHUNK_BATCH) {
    const batch = rows.slice(i, i + CHUNK_BATCH);
    await retryDb(async () => {
      const r = await client.from("chunks").insert(batch);
      if (r.error) throw new Error(`replaceChunks insert: ${r.error.message}`);
    });
  }
}

/** Fetch a batch of chunks whose embedding is still null (for resumable backfill). */
export async function fetchNullEmbeddingChunks(
  projectId: string,
  ref: string,
  limit = 256,
): Promise<Array<{ id: string; content: string; content_hash: string }>> {
  const { data, error } = await db()
    .from("chunks")
    .select("id,content,content_hash")
    .eq("project_id", projectId)
    .eq("ref", ref)
    .is("embedding", null)
    .order("content_hash")
    .limit(limit);
  if (error) throw new Error(`fetchNullEmbeddingChunks: ${error.message}`);
  return (data ?? []) as Array<{ id: string; content: string; content_hash: string }>;
}

/** Look up which content_hashes already have an embedding (cache hit). Batched: Supabase
 *  REST rejects overly long `.in()` lists (414), so chunk into groups. */
export async function existingEmbeddingHashes(
  projectId: string,
  hashes: string[],
): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>();
  if (hashes.length === 0) return map;
  const BATCH = 100;
  for (let i = 0; i < hashes.length; i += BATCH) {
    const batch = hashes.slice(i, i + BATCH);
    const res = await db()
      .from("chunks")
      .select("content_hash,embedding")
      .eq("project_id", projectId)
      .in("content_hash", batch)
      .not("embedding", "is", null);
    if (res.error) throw new Error(`existingEmbeddingHashes: ${res.error.message ?? "Bad Request"}`);
    for (const r of res.data ?? []) {
      if (r.embedding && !map.has(r.content_hash)) {
        map.set(r.content_hash, r.embedding as unknown as number[]);
      }
    }
  }
  return map;
}

/** Update embedding for a specific chunk row (by id). Used by the resumable backfill. */
export async function setChunkEmbeddingById(id: string, embedding: number[]): Promise<void> {
  const { error } = await db().from("chunks").update({ embedding }).eq("id", id);
  if (error) throw new Error(`setChunkEmbeddingById(${id}): ${error.message}`);
}

/**
 * Update ALL chunks matching a content_hash with one embedding (project-scoped).
 * One call per unique hash — far cheaper than per-id updates when content repeats,
 * and these calls are meant to be run concurrently by the backfill.
 */
export async function setChunksEmbeddingByHash(
  projectId: string,
  contentHash: string,
  embedding: number[],
): Promise<number> {
  const { count, error } = await db()
    .from("chunks")
    .update({ embedding }, { count: "exact" })
    .eq("project_id", projectId)
    .eq("content_hash", contentHash);
  if (error) throw new Error(`setChunksEmbeddingByHash(${contentHash}): ${error.message}`);
  return count ?? 0;
}

/** Backfill embeddings for chunks by content_hash. */
export async function setChunkEmbeddings(
  projectId: string,
  embeddingsByHash: Map<string, number[]>,
): Promise<void> {
  for (const [hash, embedding] of embeddingsByHash) {
    const { error } = await db()
      .from("chunks")
      .update({ embedding })
      .eq("project_id", projectId)
      .eq("content_hash", hash);
    if (error) throw new Error(`setChunkEmbeddings(${hash}): ${error.message}`);
  }
}

export interface MemoryRow {
  id: string;
  session_id: string;
  kind: string;
  title: string | null;
  content: string;
  confidence: number;
  created_at: string;
  superseded_by: string | null;
}

/** List memories for a project, newest first. Optional kind + session filters. */
export async function listMemories(
  projectId: string,
  opts: { kind?: string; session?: string; limit?: number; offset?: number } = {},
): Promise<MemoryRow[]> {
  let q = db()
    .from("memories")
    .select("id,session_id,kind,title,content,confidence,created_at,superseded_by")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 50);
  if (opts.kind) q = q.eq("kind", opts.kind);
  if (opts.session) q = q.eq("session_id", opts.session);
  if (opts.offset) q = q.range(opts.offset, opts.offset + (opts.limit ?? 50) - 1);
  const { data, error } = await q;
  if (error) throw new Error(`listMemories: ${error.message}`);
  return (data ?? []) as MemoryRow[];
}

export interface SkillRow {
  id: string;
  slug: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Fetch a single memory by id for deletion preview. */
export async function getMemoryById(
  id: string,
): Promise<{ kind: string; title: string | null; content: string; session_id: string } | null> {
  const { data, error } = await db()
    .from("memories")
    .select("kind,title,content,session_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getMemoryById: ${error.message}`);
  return data as { kind: string; title: string | null; content: string; session_id: string } | null;
}

/** Create or update a skill by slug (upsert). Returns the skill id. */
export async function upsertSkill(
  projectId: string,
  slug: string,
  title: string,
  content: string,
  embedding: number[],
  metadata: Record<string, unknown> = {},
): Promise<string> {
  const { data, error } = await db()
    .from("skills")
    .upsert(
      {
        project_id: projectId,
        slug,
        title,
        content,
        content_hash: (await import("@kb/core")).sha256(content),
        embedding,
        metadata,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "project_id,slug" },
    )
    .select("id")
    .single();
  if (error) throw new Error(`upsertSkill: ${error.message}`);
  return data.id as string;
}

/** List all skills for a project (no embeddings). */
export async function listSkills(projectId: string): Promise<SkillRow[]> {
  const { data, error } = await db()
    .from("skills")
    .select("id,slug,title,content,metadata,created_at,updated_at")
    .eq("project_id", projectId)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`listSkills: ${error.message}`);
  return (data ?? []) as SkillRow[];
}

/** Fetch all skills with embeddings (for in-memory semantic ranking). */
export async function getSkillsWithEmbeddings(
  projectId: string,
): Promise<Array<SkillRow & { embedding: number[] | null }>> {
  const { data, error } = await db()
    .from("skills")
    .select("id,slug,title,content,metadata,created_at,updated_at,embedding")
    .eq("project_id", projectId);
  if (error) throw new Error(`getSkillsWithEmbeddings: ${error.message}`);
  return (data ?? []) as Array<SkillRow & { embedding: number[] | null }>;
}

/** Delete a skill by slug, or all skills for a project. Returns count removed. */
export async function deleteSkill(
  projectId: string,
  opts: { slug?: string },
): Promise<number> {
  let q = db().from("skills").delete({ count: "exact" }).eq("project_id", projectId);
  if (opts.slug) q = q.eq("slug", opts.slug);
  const { count, error } = await q;
  if (error) throw new Error(`deleteSkill: ${error.message}`);
  return count ?? 0;
}

export async function insertMemory(
  projectId: string,
  sessionId: string,
  m: DistilledMemory,
  embedding: number[] | null,
  sourceLogPath?: string,
): Promise<string> {
  const { data, error } = await db()
    .from("memories")
    .insert({
      project_id: projectId,
      session_id: sessionId,
      kind: m.kind,
      title: m.title,
      content: m.content,
      source_log_path: sourceLogPath ?? null,
      embedding,
      metadata: m.metadata ?? {},
      confidence: m.confidence ?? 0.5,
    })
    .select("id")
    .single();
  if (error) throw new Error(`insertMemory: ${error.message}`);
  return data.id as string;
}
