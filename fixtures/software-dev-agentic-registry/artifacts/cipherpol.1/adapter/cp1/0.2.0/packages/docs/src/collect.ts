import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { sha256 } from "@kb/core";
import type { DocFile } from "./types.js";
import { splitFrontmatter, validateFrontmatter } from "./frontmatter.js";
import { buildDocChunks } from "./chunk.js";

/** Recursively list every .md file under `root`. */
export function walkDocs(root: string): string[] {
  const entries = readdirSync(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => join(e.parentPath ?? (e as unknown as { path: string }).path, e.name))
    .sort();
}

/**
 * Read, parse, validate, and chunk every doc under `root`. Pure over the
 * filesystem — no DB, no embeddings. `content_hash` is recomputed from the body
 * (never trusted from stale frontmatter). `doc_id` falls back to a path-derived
 * id when absent.
 */
export function collectDocs(root: string, opts: { ref: string }): DocFile[] {
  const out: DocFile[] = [];
  for (const path of walkDocs(root)) {
    const raw = readFileSync(path, "utf8");
    const relPath = relative(root, path);
    const { fm, body } = splitFrontmatter(raw);
    const { frontmatter, errors, warnings } = validateFrontmatter(fm, { ref: opts.ref });

    if (!frontmatter.doc_id) {
      frontmatter.doc_id = `local:${relPath.replace(/\\/g, "/").replace(/\.md$/, "")}`;
    }
    // rule 6: recompute content_hash from the body; flag drift from the stored value.
    const bodyHash = sha256(body);
    if (frontmatter.content_hash && frontmatter.content_hash !== bodyHash) {
      warnings.push("content_hash in frontmatter differs from body (recomputed)");
    }
    frontmatter.content_hash = bodyHash;

    const chunks = buildDocChunks(body, frontmatter);
    out.push({
      path,
      relPath: relPath.split(sep).join("/"),
      frontmatter,
      body,
      chunks,
      warnings: [...errors.map((e) => `ERROR: ${e}`), ...warnings],
    });
  }
  return out;
}
