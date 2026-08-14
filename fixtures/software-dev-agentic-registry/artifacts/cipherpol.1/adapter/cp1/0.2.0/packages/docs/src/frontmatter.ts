import {
  type DocFrontmatter,
  DOC_TYPES,
  SOURCES,
  PLATFORMS,
  INTEGRATIONS,
  STATUSES,
  GLOBAL_PROJECT,
} from "./types.js";

type Raw = Record<string, string | string[]>;

/** Split a normalized artifact into its YAML frontmatter (flat scalars + inline
 *  `[a, b]` arrays — the shape this pipeline writes) and its markdown body. */
export function splitFrontmatter(raw: string): { fm: Raw; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: raw };
  const fm: Raw = {};
  for (const line of (m[1] ?? "").split("\n")) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!;
    const v = (kv[2] ?? "").trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      fm[key] = v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (v !== "") {
      fm[key] = v;
    }
  }
  return { fm, body: m[2] ?? "" };
}

const asArray = (v: string | string[] | undefined): string[] | undefined =>
  v === undefined ? undefined : Array.isArray(v) ? v : [v];
const asString = (v: string | string[] | undefined): string | undefined =>
  v === undefined ? undefined : Array.isArray(v) ? v[0] : v;

/**
 * Validate + normalize raw frontmatter into a DocFrontmatter, per the spec.
 * Returns the frontmatter (with defaults applied) plus `errors` (block indexing)
 * and `warnings` (indexed but flagged). Never throws.
 */
export function validateFrontmatter(
  fm: Raw,
  defaults: { ref: string },
): { frontmatter: DocFrontmatter; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const oneOf = (val: string | undefined, allowed: readonly string[], field: string, hard = true) => {
    if (val !== undefined && !allowed.includes(val)) {
      (hard ? errors : warnings).push(`${field}="${val}" not in {${allowed.join("|")}}`);
    }
  };

  const title = asString(fm.title);
  const doc_type = asString(fm.doc_type);
  if (!title) errors.push("missing required `title`");
  if (!doc_type) errors.push("missing required `doc_type`");
  oneOf(doc_type, DOC_TYPES, "doc_type");

  const source = asString(fm.source) ?? "local";
  oneOf(source, SOURCES, "source");

  const platform = asArray(fm.platform);
  platform?.forEach((p) => oneOf(p, PLATFORMS, "platform"));

  const integration = asString(fm.integration);
  oneOf(integration, INTEGRATIONS, "integration");

  const status = (asString(fm.status) ?? "active") as DocFrontmatter["status"];
  oneOf(status, STATUSES, "status", false);

  // rule 3/8: default project scope; integration only meaningful for mobile
  const projects = asArray(fm.projects) ?? [GLOBAL_PROJECT];
  const mobile = ["flutter", "ios", "android"];
  if (integration && !(platform ?? []).some((p) => mobile.includes(p))) {
    warnings.push(`integration="${integration}" set but no mobile platform`);
  }

  const frontmatter: DocFrontmatter = {
    title: title ?? "(untitled)",
    doc_type: (doc_type ?? "other") as DocFrontmatter["doc_type"],
    projects,
    platform: platform as DocFrontmatter["platform"],
    integration: integration as DocFrontmatter["integration"],
    ref: asString(fm.ref) ?? defaults.ref,
    source,
    doc_id: asString(fm.doc_id) ?? "",
    status,
    tags: asArray(fm.tags),
    url: asString(fm.url),
    space: asString(fm.space),
    version: asString(fm.version),
    content_hash: asString(fm.content_hash),
    fetched_at: asString(fm.fetched_at),
    updated_at: asString(fm.updated_at),
    owner: asString(fm.owner),
    related_symbols: asArray(fm.related_symbols),
  };
  return { frontmatter, errors, warnings };
}
