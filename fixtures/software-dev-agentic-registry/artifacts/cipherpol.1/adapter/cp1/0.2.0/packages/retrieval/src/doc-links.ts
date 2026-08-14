import {
  getProjectIdBySlug,
  findDocChunksByRelatedSymbol,
  getDocMetaByDocId,
  getSymbol,
} from "@kb/db";

/**
 * Doc ↔ code cross-links. Docs live on the docs ref, code on a code ref, so the
 * link crosses refs and can't live in the ref-scoped `edges` table. Instead a
 * doc declares `related_symbols` (fqns) in its frontmatter → chunk metadata, and
 * we resolve in both directions at query time:
 *   - codeForDoc:   doc → code  ("the code implementing this requirement")
 *   - docsForSymbol: code → docs ("the requirement behind this code")
 */

export interface DocRef {
  docId: string;
  title: string;
  docType: string;
  ref: string;
}

export interface CodeRef {
  fqn: string;
  kind: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  ref: string;
}

const s = (v: unknown): string => (typeof v === "string" ? v : "");

/** code → docs: which docs document this code symbol. */
export async function docsForSymbol(
  slug: string,
  fqn: string,
): Promise<{ docs: DocRef[]; markdown: string }> {
  const projectId = await getProjectIdBySlug(slug);
  if (!projectId) throw new Error(`Unknown project: ${slug}`);

  const rows = await findDocChunksByRelatedSymbol(projectId, fqn);
  const byDoc = new Map<string, DocRef>();
  for (const r of rows) {
    const docId = s(r.metadata.file_path);
    if (!docId || byDoc.has(docId)) continue;
    byDoc.set(docId, {
      docId,
      title: s(r.metadata.title) || docId,
      docType: s(r.metadata.doc_type) || "?",
      ref: r.ref,
    });
  }
  const docs = [...byDoc.values()];

  const lines = [`# Docs documenting \`${fqn}\`  ·  ${slug}`, ""];
  if (docs.length === 0) lines.push("_No documentation links this symbol._");
  else for (const d of docs) lines.push(`- **${d.title}**  ·  \`${d.docType}\`  ·  ${d.docId}  _[${d.ref}]_`);
  return { docs, markdown: lines.join("\n") };
}

/** doc → code: the code symbols this doc's `related_symbols` point at. */
export async function codeForDoc(
  slug: string,
  docId: string,
): Promise<{ symbols: CodeRef[]; unresolved: string[]; markdown: string }> {
  const projectId = await getProjectIdBySlug(slug);
  if (!projectId) throw new Error(`Unknown project: ${slug}`);

  const meta = await getDocMetaByDocId(projectId, docId);
  if (!meta) throw new Error(`No indexed doc with doc_id: ${docId}`);
  const fqns = Array.isArray(meta.related_symbols) ? (meta.related_symbols as string[]) : [];

  const symbols: CodeRef[] = [];
  const unresolved: string[] = [];
  for (const fqn of fqns) {
    const sym = await getSymbol(projectId, { fqn }); // any ref; docs have no symbols
    if (sym) {
      symbols.push({
        fqn: sym.fqn,
        kind: sym.kind,
        filePath: sym.file_path,
        startLine: sym.start_line,
        endLine: sym.end_line,
        ref: sym.ref,
      });
    } else {
      unresolved.push(fqn);
    }
  }

  const title = s(meta.title) || docId;
  const lines = [`# Code documented by **${title}**  ·  ${slug}`, ""];
  if (symbols.length === 0 && unresolved.length === 0) lines.push("_This doc declares no related_symbols._");
  for (const c of symbols) {
    const loc = c.filePath ? `${c.filePath}:${(c.startLine ?? 0) + 1}-${(c.endLine ?? 0) + 1}` : "";
    lines.push(`- \`${c.fqn}\`  ·  ${c.kind}  ·  ${loc}  _[${c.ref}]_`);
  }
  if (unresolved.length) lines.push("", `_Unresolved (${unresolved.length}): ${unresolved.map((u) => `\`${u}\``).join(", ")}_`);
  return { symbols, unresolved, markdown: lines.join("\n") };
}
