/**
 * A "ref" scopes a knowledge snapshot of a project: a git tag, a git branch,
 * or a user-named input. The same project can be indexed at many refs that
 * coexist in the DB and on disk, searched independently.
 *
 *   "branch:main"  "tag:v1.2.0"  "user:experiment-a"  "docs:latest"
 *
 * `docs` scopes documentation snapshots (PRDs/RFCs/standards), kept separate
 * from code refs so code and doc retrieval don't mix — see
 * docs/doc-source-ingestion/README.md.
 */
export type RefKind = "tag" | "branch" | "user" | "docs";

export interface Ref {
  kind: RefKind;
  name: string;
  /** Canonical "kind:name" string stored in the DB. */
  raw: string;
}

/** On-disk folder category per kind: knowledge/<category>/<name>/... */
const DIR_CATEGORY: Record<RefKind, string> = {
  tag: "tags",
  branch: "branches",
  user: "user_inputed",
  docs: "docs",
};

const KINDS: RefKind[] = ["tag", "branch", "user", "docs"];

/** Parse "kind:name" (bare strings default to a branch). */
export function parseRef(input: string): Ref {
  const idx = input.indexOf(":");
  let kind: RefKind = "branch";
  let name = input;
  if (idx > 0) {
    const k = input.slice(0, idx) as RefKind;
    if (KINDS.includes(k)) {
      kind = k;
      name = input.slice(idx + 1);
    }
  }
  name = name.trim() || "main";
  return { kind, name, raw: `${kind}:${name}` };
}

/** Repo-relative knowledge dir for a ref: knowledge/<category>/<name>. */
export function refKnowledgeDir(ref: Ref): string {
  const safeName = ref.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${DIR_CATEGORY[ref.kind]}/${safeName}`;
}
