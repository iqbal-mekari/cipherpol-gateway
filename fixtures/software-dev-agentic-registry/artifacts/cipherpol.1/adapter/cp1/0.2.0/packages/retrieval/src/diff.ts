import { getProjectIdBySlug, symbolsForRef, type RefSymbolRow } from "@kb/db";

async function resolveProject(slug: string): Promise<string> {
  const id = await getProjectIdBySlug(slug);
  if (!id) throw new Error(`Unknown project: ${slug}`);
  return id;
}

export interface ChangedSymbol {
  fqn: string;
  file_path: string;
  before: RefSymbolRow;
  after: RefSymbolRow;
}

export interface SymbolDiff {
  added: RefSymbolRow[];
  removed: RefSymbolRow[];
  changed: ChangedSymbol[];
}

/**
 * Diff two symbol sets by matching on `fqn`: present only in `b` → added,
 * present only in `a` → removed, present in both but signature/source differs
 * (content_hash) → changed. If a ref has multiple symbols sharing an fqn
 * (e.g. dartdoc getter/setter pairs), the last one wins — a rare edge case
 * this diff doesn't attempt to disambiguate further.
 */
export function computeSymbolDiff(a: RefSymbolRow[], b: RefSymbolRow[]): SymbolDiff {
  const byFqnA = new Map(a.map((s) => [s.fqn, s]));
  const byFqnB = new Map(b.map((s) => [s.fqn, s]));

  const added: RefSymbolRow[] = [];
  const changed: ChangedSymbol[] = [];
  for (const [fqn, sb] of byFqnB) {
    const sa = byFqnA.get(fqn);
    if (!sa) {
      added.push(sb);
    } else if (sa.content_hash !== sb.content_hash || sa.signature !== sb.signature) {
      changed.push({ fqn, file_path: sb.file_path, before: sa, after: sb });
    }
  }

  const removed: RefSymbolRow[] = [];
  for (const [fqn, sa] of byFqnA) {
    if (!byFqnB.has(fqn)) removed.push(sa);
  }

  return { added, removed, changed };
}

/** Ref/snapshot diff, rendered as markdown grouped by file (codegraph's diff equivalent). */
export async function diffRefsCard(
  slug: string,
  refA: string,
  refB: string,
  pathPrefix?: string | null,
): Promise<string> {
  const projectId = await resolveProject(slug);
  const [a, b] = await Promise.all([
    symbolsForRef(projectId, refA, pathPrefix),
    symbolsForRef(projectId, refB, pathPrefix),
  ]);
  // "module" is a synthetic per-file anchor symbol (see extractFromTree), not a
  // real declaration — exclude it from the diff, same as sync.ts's symbol counts.
  const real = (rows: RefSymbolRow[]) => rows.filter((r) => r.kind !== "module");
  const { added, removed, changed } = computeSymbolDiff(real(a), real(b));

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return `# Diff ${refA} → ${refB}\n\n_No symbol differences found${pathPrefix ? ` under \`${pathPrefix}\`` : ""}._`;
  }

  const byFile = new Map<string, { added: RefSymbolRow[]; removed: RefSymbolRow[]; changed: ChangedSymbol[] }>();
  const bucket = (file: string) => {
    let g = byFile.get(file);
    if (!g) {
      g = { added: [], removed: [], changed: [] };
      byFile.set(file, g);
    }
    return g;
  };
  for (const s of added) bucket(s.file_path).added.push(s);
  for (const s of removed) bucket(s.file_path).removed.push(s);
  for (const c of changed) bucket(c.file_path).changed.push(c);

  const lines = [
    `# Diff ${refA} → ${refB}`,
    "",
    `**${added.length}** added · **${removed.length}** removed · **${changed.length}** changed, across **${byFile.size}** files.`,
    "",
  ];
  for (const [file, g] of [...byFile.entries()].sort(([x], [y]) => x.localeCompare(y))) {
    lines.push(`### ${file}`);
    for (const s of g.added) lines.push(`- \`+\` **${s.fqn}** (${s.kind})`);
    for (const s of g.removed) lines.push(`- \`-\` **${s.fqn}** (${s.kind})`);
    for (const c of g.changed) lines.push(`- \`~\` **${c.fqn}** (${c.after.kind})`);
    lines.push("");
  }
  return lines.join("\n");
}
