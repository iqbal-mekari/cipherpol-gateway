import type { ExtractedFile, EdgeRel } from "@kb/core";

/**
 * Project-wide reference resolution. Edge targets are captured as bare names
 * (callee/superclass/import identifiers). We resolve each to a symbol key by
 * matching on the symbol's short `name`:
 *   - exactly one symbol with that name  → resolve (set dstKey)
 *   - zero or many (ambiguous)           → leave unresolved, keep dstFqn
 *
 * This is intentionally conservative — wrong edges are worse than missing ones
 * for graph traversal. Import-scoped disambiguation can refine this later.
 */
export function resolveEdges(files: ExtractedFile[]): void {
  const nameToKeys = new Map<string, string[]>();
  for (const f of files) {
    for (const s of f.symbols) {
      if (s.kind === "module") continue;
      const arr = nameToKeys.get(s.name);
      if (arr) arr.push(s.key);
      else nameToKeys.set(s.name, [s.key]);
    }
  }

  for (const f of files) {
    for (const e of f.edges) {
      if (e.dstKey || !e.dstFqn) continue;
      const candidates = nameToKeys.get(e.dstFqn);
      if (candidates && candidates.length === 1) {
        e.dstKey = candidates[0];
        // keep dstFqn too; repo prefers dstKey when present
      }
    }
  }
}

/** Count resolved vs total edges, for CLI/validation output. */
export function edgeStats(files: ExtractedFile[]): { total: number; resolved: number } {
  let total = 0;
  let resolved = 0;
  for (const f of files) {
    for (const e of f.edges as EdgeRel[]) {
      total++;
      if (e.dstKey) resolved++;
    }
  }
  return { total, resolved };
}
