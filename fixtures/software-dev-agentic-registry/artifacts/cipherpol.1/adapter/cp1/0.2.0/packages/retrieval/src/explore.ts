import {
  getProjectIdBySlug,
  getSymbol,
  getNeighbors,
  impact,
  type NeighborRow,
} from "@kb/db";

async function resolveProject(slug: string): Promise<string> {
  const id = await getProjectIdBySlug(slug);
  if (!id) throw new Error(`Unknown project: ${slug}`);
  return id;
}

/** Full verbatim card for one symbol (codegraph's get-node equivalent). */
export async function symbolCard(slug: string, by: { id?: string; fqn?: string; ref?: string }): Promise<string> {
  const projectId = await resolveProject(slug);
  const s = await getSymbol(projectId, by);
  if (!s) return `_Symbol not found: ${by.fqn ?? by.id}_`;

  const fence = s.language === "python" ? "python" : s.language;
  const lines = [
    `# ${s.fqn}`,
    "",
    `**kind** ${s.kind} · **file** ${s.file_path ?? "?"}:${s.start_line + 1}-${s.end_line + 1} · **exported** ${s.is_exported}`,
  ];
  if (s.signature) lines.push("", `\`${s.signature}\``);
  if (s.doc_comment) lines.push("", s.doc_comment);
  if (s.last_commit_hash) {
    const date = s.last_commit_date ? s.last_commit_date.slice(0, 10) : "?";
    lines.push("", `**last touched** \`${s.last_commit_hash.slice(0, 8)}\` by ${s.last_commit_author ?? "?"} on ${date} — _"${s.last_commit_subject ?? ""}"_`);
  }
  lines.push("", "```" + fence, s.source_text ?? "(source unavailable)", "```");
  return lines.join("\n");
}

/** Callers + callees of a symbol, grouped by direction (codegraph callers/callees). */
export async function neighborsCard(slug: string, symbolId: string): Promise<string> {
  const projectId = await resolveProject(slug);
  const s = await getSymbol(projectId, { id: symbolId });
  const ns = await getNeighbors(projectId, symbolId);
  const out = ns.filter((n) => n.direction === "out");
  const inc = ns.filter((n) => n.direction === "in");

  const fmt = (rows: NeighborRow[]) =>
    rows.length
      ? rows.map((n) => `- \`${n.edge_kind}\` **${n.fqn}** (${n.kind}) — ${n.file_path}`).join("\n")
      : "_none_";

  return [
    `# Neighbors of ${s?.fqn ?? symbolId}`,
    "",
    `## Outgoing (this → others)`,
    fmt(out),
    "",
    `## Incoming (others → this)`,
    fmt(inc),
  ].join("\n");
}

/** Reverse-transitive blast radius: who is affected if this symbol changes. */
export async function impactCard(slug: string, symbolId: string, maxDepth = 3): Promise<string> {
  const projectId = await resolveProject(slug);
  const s = await getSymbol(projectId, { id: symbolId });
  if (!s) return `_Symbol not found: ${symbolId}_`;
  const nodes = await impact(projectId, s.ref, symbolId, maxDepth);
  if (nodes.length === 0) return `# Impact of ${s?.fqn ?? symbolId}\n\n_No dependents found (nothing references it)._`;

  const byFile = new Map<string, typeof nodes>();
  for (const n of nodes) {
    const arr = byFile.get(n.file_path) ?? [];
    arr.push(n);
    byFile.set(n.file_path, arr);
  }
  const lines = [
    `# Impact of ${s?.fqn ?? symbolId}`,
    "",
    `Changing this affects **${nodes.length}** symbols across **${byFile.size}** files.`,
    "",
  ];
  for (const [file, arr] of byFile) {
    lines.push(`### ${file}`);
    for (const n of arr.sort((a, b) => a.depth - b.depth)) {
      lines.push(`- **${n.fqn}** (${n.kind}) _[depth ${n.depth}]_`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
