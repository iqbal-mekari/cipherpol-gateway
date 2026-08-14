import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtractedFile, Chunk } from "@kb/core";
import { config, parseRef, refKnowledgeDir, mapLimit } from "@kb/core";
import { walkSourceFiles, readSource, extractFile, extractDartFiles, resolveEdges, fileProvenance } from "@kb/extractor";
import {
  ensureProject,
  upsertFile,
  replaceSymbols,
  replaceEdges,
  replaceChunks,
  resolveCrossFileEdges,
  existingEmbeddingHashes,
  setChunksEmbeddingByHash,
} from "@kb/db";
import { embedDocuments } from "@kb/embeddings";
import { buildChunks, renderSymbolMarkdown, knowledgeRelPath } from "./markdown.js";

export interface IndexResult {
  project: string;
  ref: string;
  files: number;
  symbols: number;
  edges: number;
  chunks: number;
  embeddedNew: number;
  embeddedCached: number;
  resolvedCrossFile: number;
}

export interface IndexOptions {
  /** Root of the codebase to index. */
  root: string;
  /** Project slug (folder name under projects/). */
  slug: string;
  /** Knowledge snapshot ref, e.g. "branch:main" | "tag:v1.2" | "user:label". */
  ref?: string;
  commit?: string;
  /** Skip the embedding step (structure-only; chunks stay embedding=null). */
  skipEmbeddings?: boolean;
  /** Write knowledge/*.md artifacts to disk. */
  writeMarkdown?: boolean;
  /** Bypass the content-hash embedding cache and re-embed everything. */
  force?: boolean;
  /** Include full source code in chunk embedding text. Default false — reduces storage
   *  ~85% at the cost of not encoding implementation bodies in vector search. */
  includeSourceInEmbedding?: boolean;
}

/**
 * Full (re)index of a codebase at a given ref. Extraction + resolution happen
 * in memory, then structure is persisted, then embeddings are backfilled by
 * content_hash so unchanged code is never re-embedded (cache spans all refs —
 * identical code on two branches embeds once).
 */
export async function indexProject(opts: IndexOptions): Promise<IndexResult> {
  const { root, slug, commit } = opts;
  const ref = parseRef(opts.ref ?? config.defaultRef());

  // 1. Extract every supported file. Dart goes through the dartdoc_json analyzer
  //    backend (doc comments, typed params, inheritance edges); other languages
  //    use tree-sitter per-file.
  const paths = await walkSourceFiles(root);
  const dartFiles = paths.filter((p) => p.endsWith(".dart"));
  const otherFiles = paths.filter((p) => !p.endsWith(".dart"));
  const files: ExtractedFile[] = [];
  for (const p of otherFiles) {
    const ex = await extractFile(p, await readSource(root, p));
    if (ex) files.push(ex);
  }
  if (dartFiles.length > 0) files.push(...(await extractDartFiles(root, dartFiles)));

  // 1b. One-shot git-log walk for per-file provenance (last commit touching each
  //     path). Best-effort: empty map if root isn't a git repo — never blocks indexing.
  const provenance = await fileProvenance(root);

  // 2. Resolve edge targets across the whole project (in memory).
  resolveEdges(files);

  // 3. Build chunks in memory (needed before persistence for the embedding cache).
  const chunksByFile = new Map<string, Chunk[]>();
  for (const f of files) chunksByFile.set(f.path, buildChunks(f, slug, commit, opts.includeSourceInEmbedding ?? false));

  const projectId = await ensureProject(slug);

  // 4. Snapshot the embedding cache BEFORE rewriting chunks (keyed by content_hash,
  //    ref-independent). For a no-op re-index every hash is found here → no model run.
  const allChunks = [...chunksByFile.values()].flat();
  const contentByHash = new Map<string, string>();
  for (const c of allChunks) if (!contentByHash.has(c.contentHash)) contentByHash.set(c.contentHash, c.content);
  const neededHashes = [...contentByHash.keys()];
  const cache =
    opts.skipEmbeddings || opts.force
      ? new Map<string, number[]>()
      : await existingEmbeddingHashes(projectId, neededHashes);

  // 5. Persist files + symbols for this ref (concurrent across files), accumulating
  //    a project-wide key→id map. Bounded concurrency: each file is independent HTTP work.
  const keyToId = new Map<string, string>();
  const fileIds = new Map<string, string>();
  const CONCURRENCY = Number(process.env.KB_INDEX_CONCURRENCY ?? "6");
  await mapLimit(files, CONCURRENCY, async (f) => {
    const fileId = await upsertFile(projectId, ref.raw, f, commit, provenance.get(f.path));
    fileIds.set(f.path, fileId);
    const map = await replaceSymbols(projectId, ref.raw, fileId, f.symbols);
    for (const [k, v] of map) keyToId.set(k, v);
  });

  // 6. Insert edges using the global map (cross-file targets now resolvable).
  let edgeCount = 0;
  await mapLimit(files, CONCURRENCY, async (f) => {
    await replaceEdges(projectId, ref.raw, fileIds.get(f.path)!, f.edges, keyToId);
    edgeCount += f.edges.length;
  });
  const resolvedCrossFile = await resolveCrossFileEdges(projectId, ref.raw);

  // 7. Compute the full embedding map (cached + newly embedded).
  let embeddedNew = 0;
  let embeddedCached = 0;
  const embeddingsByHash = new Map<string, number[]>();
  if (!opts.skipEmbeddings) {
    embeddedCached = cache.size;
    for (const [h, v] of cache) embeddingsByHash.set(h, v);
    const missing = neededHashes.filter((h) => !cache.has(h));
    if (missing.length > 0) {
      const vectors = await embedDocuments(missing.map((h) => contentByHash.get(h)!));
      missing.forEach((h, i) => embeddingsByHash.set(h, vectors[i]!));
      embeddedNew = missing.length;
    }
  }

  // 8. Persist chunks WITHOUT embeddings first — concurrent inserts with the HNSW
  //    index cause statement timeouts on large repos (every insert updates the index
  //    graph). Inserting embedding=null skips HNSW writes entirely; we backfill below.
  let chunkCount = 0;
  await mapLimit(files, CONCURRENCY, async (f) => {
    const chunks = chunksByFile.get(f.path)!;
    await replaceChunks(projectId, ref.raw, fileIds.get(f.path)!, chunks, keyToId);
    chunkCount += chunks.length;
    if (opts.writeMarkdown) await writeKnowledgeFiles(slug, ref, f, commit);
  });

  // 9. Backfill embeddings sequentially (one UPDATE per unique content_hash).
  //    Sequential writes avoid concurrent HNSW lock contention.
  if (!opts.skipEmbeddings && embeddingsByHash.size > 0) {
    await mapLimit([...embeddingsByHash.entries()], 4, async ([hash, embedding]) => {
      await setChunksEmbeddingByHash(projectId, hash, embedding);
    });
  }

  return {
    project: slug,
    ref: ref.raw,
    files: files.length,
    symbols: keyToId.size,
    edges: edgeCount,
    chunks: chunkCount,
    embeddedNew,
    embeddedCached,
    resolvedCrossFile,
  };
}

/**
 * Local dry run — extract, resolve, render knowledge/*.md and build chunks
 * WITHOUT touching Supabase or the embedding model. Validates markdown + chunking.
 */
export async function dryRunMarkdown(
  root: string,
  slug: string,
  refInput?: string,
  commit?: string,
): Promise<{ ref: string; files: number; symbols: number; chunks: number; sampleChunk?: string }> {
  const ref = parseRef(refInput ?? config.defaultRef());
  const paths = await walkSourceFiles(root);
  const dartFiles = paths.filter((p) => p.endsWith(".dart"));
  const otherFiles = paths.filter((p) => !p.endsWith(".dart"));
  const files: ExtractedFile[] = [];
  for (const p of otherFiles) {
    const ex = await extractFile(p, await readSource(root, p));
    if (ex) files.push(ex);
  }
  if (dartFiles.length > 0) files.push(...(await extractDartFiles(root, dartFiles)));
  resolveEdges(files);

  let symbols = 0;
  let chunks = 0;
  let sampleChunk: string | undefined;
  for (const f of files) {
    symbols += f.symbols.filter((s) => s.kind !== "module").length;
    const cs = buildChunks(f, slug, commit);
    chunks += cs.length;
    if (!sampleChunk && cs[0]) sampleChunk = cs[0].content;
    await writeKnowledgeFiles(slug, ref, f, commit);
  }
  return { ref: ref.raw, files: files.length, symbols, chunks, sampleChunk };
}

/** Remove the entire on-disk project artifact tree (knowledge/, skills/, logs/, readme). */
export async function removeProjectDir(slug: string): Promise<void> {
  await rm(join(config.projectsRoot(), slug), { recursive: true, force: true });
}

/** Remove just one ref's knowledge dir, e.g. knowledge/branches/main. */
export async function removeRefKnowledgeDir(slug: string, refInput: string): Promise<void> {
  const ref = parseRef(refInput);
  await rm(join(config.projectsRoot(), slug, "knowledge", refKnowledgeDir(ref)), {
    recursive: true,
    force: true,
  });
}

async function writeKnowledgeFiles(
  slug: string,
  ref: ReturnType<typeof parseRef>,
  file: ExtractedFile,
  commit?: string,
): Promise<void> {
  // projects/<slug>/knowledge/<branches|tags|user_inputed>/<name>/<lang>/<fqn>.md
  const base = join(config.projectsRoot(), slug, "knowledge", refKnowledgeDir(ref));
  for (const s of file.symbols) {
    if (s.kind === "module") continue;
    const full = join(base, knowledgeRelPath(s));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, renderSymbolMarkdown(s, file.edges, slug, commit), "utf8");
  }
}
