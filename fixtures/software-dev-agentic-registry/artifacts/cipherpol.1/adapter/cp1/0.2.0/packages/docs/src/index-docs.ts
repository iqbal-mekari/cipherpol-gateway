import { parseRef, type Chunk, type ChunkMetadata } from "@kb/core";
import {
  ensureProject,
  upsertFile,
  replaceChunks,
  existingEmbeddingHashes,
} from "@kb/db";
import { embedDocuments } from "@kb/embeddings";
import { collectDocs } from "./collect.js";
import type { DocFile } from "./types.js";

export interface IndexDocsOptions {
  root: string;
  ref?: string;
  /** Re-embed everything, bypassing the content-hash cache. */
  force?: boolean;
  /** Persist chunks with embedding=null (structure/FTS only). */
  skipEmbeddings?: boolean;
}

export interface IndexDocsResult {
  ref: string;
  docs: number;
  files: number; // fanned out per project
  chunks: number;
  projects: string[];
  embeddedNew: number;
  embeddedCached: number;
}

/**
 * Index the normalized documentation corpus at `root` into Supabase under a
 * dedicated docs ref. Mirrors the code path (@kb/knowledge indexProject):
 * extract in memory → ensure projects → embed by content_hash (cache-aware) →
 * upsert files + chunks. A doc listing multiple `projects` is fanned out (one
 * file row per project); identical chunk content embeds once (hash cache).
 */
export async function indexDocs(opts: IndexDocsOptions): Promise<IndexDocsResult> {
  const ref = parseRef(opts.ref ?? "docs:latest").raw;
  const docs = collectDocs(opts.root, { ref });

  const bad = docs.filter((d) => d.warnings.some((w) => w.startsWith("ERROR")));
  if (bad.length) {
    throw new Error(
      `${bad.length} doc(s) have validation errors — run \`index-docs --dry\` to see them, then fix before indexing.`,
    );
  }

  // 1. Ensure every referenced project exists (incl. _global).
  const slugs = [...new Set(docs.flatMap((d) => d.frontmatter.projects))];
  const projectIds = new Map<string, string>();
  for (const slug of slugs) projectIds.set(slug, await ensureProject(slug));

  // 2. Embed unique chunk contents (cache-aware). Cache is project-scoped, so
  //    union the hits across the projects we touch; embed the remainder once.
  const contentByHash = new Map<string, string>();
  for (const d of docs) for (const c of d.chunks) if (!contentByHash.has(c.contentHash)) contentByHash.set(c.contentHash, c.content);
  const hashes = [...contentByHash.keys()];

  const embeddingsByHash = new Map<string, number[]>();
  let embeddedCached = 0;
  if (!opts.skipEmbeddings) {
    if (!opts.force) {
      for (const pid of projectIds.values()) {
        for (const [h, v] of await existingEmbeddingHashes(pid, hashes)) {
          if (!embeddingsByHash.has(h)) embeddingsByHash.set(h, v);
        }
      }
    }
    embeddedCached = embeddingsByHash.size;
    const missing = hashes.filter((h) => !embeddingsByHash.has(h));
    if (missing.length) {
      const vectors = await embedDocuments(missing.map((h) => contentByHash.get(h)!));
      missing.forEach((h, i) => embeddingsByHash.set(h, vectors[i]!));
    }
  }

  // 3. Persist: one file row per (doc × project); doc chunks fanned to each.
  let fileCount = 0;
  let chunkCount = 0;
  for (const d of docs) {
    for (const slug of d.frontmatter.projects) {
      const pid = projectIds.get(slug)!;
      const fileId = await upsertFile(pid, ref, {
        path: d.frontmatter.doc_id,
        language: "markdown",
        contentHash: d.frontmatter.content_hash!,
        loc: d.body.split("\n").length,
        sizeBytes: Buffer.byteLength(d.body, "utf8"),
      });
      const chunks: Chunk[] = d.chunks.map((c) => ({
        chunkIndex: c.chunkIndex,
        content: c.content,
        contentHash: c.contentHash,
        // metadata is jsonb; carry the full doc metadata + the per-project slug.
        metadata: { ...c.metadata, project: slug } as unknown as ChunkMetadata,
      }));
      await replaceChunks(pid, ref, fileId, chunks, new Map(), opts.skipEmbeddings ? undefined : embeddingsByHash);
      fileCount++;
      chunkCount += chunks.length;
    }
  }

  return {
    ref,
    docs: docs.length,
    files: fileCount,
    chunks: chunkCount,
    projects: slugs,
    embeddedNew: opts.skipEmbeddings ? 0 : hashes.length - embeddedCached,
    embeddedCached,
  };
}

export type { DocFile };
