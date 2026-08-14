/**
 * dartdoc_json extraction backend for Dart.
 *
 * Shells out to the `dartdoc_json` CLI (Dart analyzer-based) to produce rich,
 * type-resolved JSON per file, then maps it to our SymbolNode/EdgeRel shapes.
 * This is far richer than a tree-sitter query for Dart: cleaned doc comments,
 * typed parameters/returns, and inheritance edges (extends/with/implements/on).
 *
 * Requires the Dart SDK + `dart pub global activate dartdoc_json` on the host.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";
import { readFileSync } from "node:fs";
import type {
  SymbolNode,
  EdgeRel,
  EdgeKind,
  SymbolKind,
  ExtractedFile,
} from "@kb/core";
import { sha256, symbolKey } from "@kb/core";
import { extractFile } from "./extract.js";
import { readSource } from "./walk.js";

const here = dirname(fileURLToPath(import.meta.url)); // packages/extractor/src
const ROOT = join(here, "..", "..", ".."); // repo root (for temp output)

// dartdoc_json "kind" → our SymbolKind. (`constructor` is omitted: it's a
// reserved method name TS special-cases in object literals; handled in lookup.)
const KIND_MAP: Record<string, SymbolKind> = {
  class: "class",
  mixin: "class",
  extension: "class",
  enum: "enum",
  typedef: "type",
  function: "function",
  method: "method",
  getter: "method",
  setter: "method",
  field: "const",
  variable: "const",
};

function kindOf(kind: string): SymbolKind {
  if (kind === "constructor") return "method";
  return KIND_MAP[kind] ?? "function";
}

interface DartParam {
  name: string;
  type?: string;
  default?: string;
}
interface DartDecl {
  kind: string;
  name: string;
  description?: string;
  typeParameters?: { name: string }[];
  annotations?: { name: string; arguments?: string[] }[];
  members?: DartDecl[];
  extends?: string;
  with?: string[];
  implements?: string[];
  on?: string[];
  parameters?: { all?: DartParam[]; positional?: number; named?: number };
  values?: { name: string; description?: string }[];
  returns?: string;
  abstract?: boolean;
  const?: boolean;
  factory?: boolean;
  static?: boolean;
  final?: boolean;
}
interface DartUnit {
  source: string;
  directives?: { kind: string; uri: string; show?: string[]; as?: string }[];
  declarations: DartDecl[];
}

/** Resolve the dartdoc_json binary: explicit env override, else ~/.pub-cache/bin. */
function resolveBin(): string {
  if (process.env.DARTDOC_JSON_BIN) return process.env.DARTDOC_JSON_BIN;
  return join(homedir(), ".pub-cache", "bin", "dartdoc_json");
}

/** Invoke dartdoc_json on a batch of files; returns parsed compilation units. */
async function runDartdocJson(
  rootAbs: string,
  files: string[],
): Promise<DartUnit[]> {
  const bin = resolveBin();
  const tmpOut = join(ROOT, ".dartdoc-tmp.json");
  const args = ["--root", rootAbs, "--output", tmpOut];
  for (const f of files) args.push(join(rootAbs, f));

  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", () =>
      reject(new Error(`dartdoc_json binary not found at ${bin} (activate: dart pub global activate dartdoc_json)`)),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`dartdoc_json exited ${code}: ${stderr.trim()}`)),
    );
  });

  try {
    return JSON.parse(readFileSync(tmpOut, "utf8")) as DartUnit[];
  } finally {
    await import("node:fs/promises").then((fs) => fs.rm(tmpOut, { force: true }));
  }
}

/** Build a human-readable signature for embedding from the declaration. */
function signatureOf(d: DartDecl): string | undefined {
  const parts: string[] = [];
  if (d.returns) parts.push(d.returns);
  parts.push(d.name);
  if (d.typeParameters?.length)
    parts.push("<" + d.typeParameters.map((t) => t.name).join(", ") + ">");
  const params = d.parameters?.all ?? [];
  if (params.length || d.kind === "function" || d.kind === "method" || d.kind === "constructor") {
    parts.push("(" + params.map((p) => [p.type, p.name].filter(Boolean).join(" ")).join(", ") + ")");
  }
  return parts.join(" ");
}

/** Rich doc context for embedding: description + modifiers + inheritance + values.
 *  Excludes fqn/signature — buildChunks' embeddingText adds those from dedicated
 *  symbol fields, so we must NOT duplicate them here (else the chunk doubles up). */
function docContextOf(d: DartDecl, kind: SymbolKind): string | undefined {
  const lines: string[] = [];
  if (d.description) lines.push(d.description.trim());
  const flags = [
    d.abstract && "abstract",
    d.const && "const",
    d.factory && "factory",
    d.static && "static",
    d.final && "final",
  ].filter(Boolean);
  if (flags.length) lines.push("modifiers: " + flags.join(" "));
  if (d.annotations?.length)
    lines.push("annotations: " + d.annotations.map((a) => a.name).join(" "));
  if (kind === "class" || kind === "enum") {
    const rel: string[] = [];
    const asArr = (v: unknown): string[] => (Array.isArray(v) ? v : v ? [v as string] : []);
    if (d.extends) rel.push("extends " + d.extends);
    const w = asArr(d.with);
    const im = asArr(d.implements);
    const on = asArr(d.on);
    if (w.length) rel.push("with " + w.join(", "));
    if (im.length) rel.push("implements " + im.join(", "));
    if (on.length) rel.push("on " + on.join(", "));
    if (rel.length) lines.push(rel.join("; "));
  }
  if (kind === "enum" && d.values?.length)
    lines.push("values: " + d.values.map((v) => v.name).join(", "));
  return lines.length ? lines.join("\n") : undefined;
}

/** Strip type args: "StatelessWidget<T>" → "StatelessWidget". */
function baseName(t: string): string {
  const i = t.search(/[<({]/);
  const s = (i >= 0 ? t.slice(0, i) : t).trim();
  return s.split(".").pop() ?? s;
}

/** Dart allows anonymous extensions ("extension on Env { ... }"), which
 *  dartdoc_json reports with no `name` field at all. Synthesize a stable
 *  one from the `on` clause so symbols.name (NOT NULL) is never violated. */
function synthesizeAnonName(d: DartDecl): string {
  if (d.kind === "extension") {
    const on = Array.isArray(d.on) ? d.on[0] : d.on;
    const target = baseName((on ?? "").replace(/^on\s+/, "").trim());
    return target ? `$AnonExtensionOn${target}` : "$AnonExtension";
  }
  return "$anonymous";
}

const INHERIT_KINDS: Array<[keyof Pick<DartDecl, "extends" | "with" | "implements" | "on">, EdgeKind]> = [
  ["extends", "extends"],
  ["implements", "implements"],
  ["with", "implements"], // mixin application: treat as implementation
  ["on", "references"], // mixin constraint
];

interface BuiltFile {
  symbols: SymbolNode[];
  edges: EdgeRel[];
  /** Synthetic per-file line counter: dartdoc_json gives no line numbers, so we
   *  assign each symbol a unique ordinal. This disambiguates same-FQN symbols
   *  (getter/setter pairs, overloads) for the (project_id,ref,fqn,start_line)
   *  unique constraint. Lines are never displayed for Dart (no source body). */
  line: number;
}

/** Bare declaration name for fqn purposes. dartdoc_json reports factory (and
 *  some named) constructors class-qualified, e.g. "Foo.create" — strip that
 *  back to "create" so the fqn isn't doubled to "...Foo.Foo.create". */
function shortName(d: DartDecl): string {
  const name = d.name || synthesizeAnonName(d);
  return d.kind === "constructor" && name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
}

/** Count fqn occurrences across the decl tree, mirroring buildDecl's own fqn
 *  derivation (without the side effects). dartdoc_json reports getter/setter
 *  pairs as two declarations sharing one fqn; tree-sitter's extractFromTree
 *  collapses same-fqn defs down to a single symbol (highest KIND_PRIORITY
 *  wins), so splicing its span onto BOTH dartdoc declarations would silently
 *  attach one span to two different bodies. Skip splicing for any fqn that
 *  isn't unique on dartdoc_json's side. */
function countFqns(d: DartDecl, prefix: string, counts: Map<string, number>): void {
  const fqn = prefix ? `${prefix}.${shortName(d)}` : shortName(d);
  counts.set(fqn, (counts.get(fqn) ?? 0) + 1);
  for (const m of d.members ?? []) countFqns(m, fqn, counts);
}

/** Recursively flatten a declaration tree into symbols + inheritance edges.
 *  tsByFqn/dupFqns (optional) splice real source/line/byte spans recovered by
 *  a parallel tree-sitter-dart pass — see extractDartFiles. */
function buildDecl(
  d: DartDecl,
  prefix: string,
  path: string,
  out: BuiltFile,
  tsByFqn?: Map<string, SymbolNode>,
  dupFqns?: Set<string>,
): void {
  const name = shortName(d);
  const kind = kindOf(d.kind);
  const fqn = prefix ? `${prefix}.${name}` : name;
  const line = out.line++;
  // Key includes the synthetic line so getter/setter pairs (same fqn, different
  // line) are distinct — otherwise their chunks collide on (symbol_id, chunk_index).
  const key = symbolKey(path, `${fqn}#${line}`);
  const sig = signatureOf(d) ?? "";
  const doc = docContextOf(d, kind) ?? "";
  // Embedding input = fqn + signature + rich doc context (built by buildChunks'
  // embeddingText from these fields). contentHash matches this exact input
  // unless a real source span was recovered below (then it hashes that instead,
  // matching how tree-sitter-derived languages compute contentHash).
  const embedInput = [fqn, sig, doc].filter(Boolean).join("\n");
  const ts = dupFqns?.has(fqn) ? undefined : tsByFqn?.get(fqn);

  out.symbols.push({
    key,
    fqn,
    name,
    kind,
    language: "dart",
    filePath: path,
    signature: sig || undefined,
    startLine: ts ? ts.startLine : line,
    endLine: ts ? ts.endLine : line,
    startByte: ts ? ts.startByte : 0,
    endByte: ts ? ts.endByte : 0,
    docComment: doc || undefined,
    source: ts ? ts.source : "",
    contentHash: ts ? sha256(ts.source) : sha256(embedInput),
    isExported: true, // dartdoc_json only reports the public API surface
  });

  // inheritance edges off this declaration
  for (const [field, ekind] of INHERIT_KINDS) {
    const val = d[field];
    if (!val) continue;
    const names = Array.isArray(val) ? val : [val]; // extends/on can be single strings
    for (const n of names) {
      out.edges.push({ srcKey: key, dstFqn: baseName(n), kind: ekind });
    }
  }

  for (const m of d.members ?? []) buildDecl(m, fqn, path, out, tsByFqn, dupFqns);
  for (const v of d.values ?? []) {
    const vfqn = `${fqn}.${v.name}`;
    const vline = out.line++;
    out.symbols.push({
      key: symbolKey(path, `${vfqn}#${vline}`),
      fqn: vfqn,
      name: v.name,
      kind: "const",
      language: "dart",
      filePath: path,
      startLine: vline,
      endLine: vline,
      startByte: 0,
      endByte: 0,
      docComment: v.description?.trim() || undefined,
      source: "",
      contentHash: sha256(`${vfqn}|${v.description ?? ""}`),
      isExported: true,
    });
  }
}

/**
 * Extract Dart files via dartdoc_json. Files are batched to keep argv bounded.
 * Returns one ExtractedFile per input (files with no declarations are skipped).
 */
export async function extractDartFiles(
  rootAbs: string,
  files: string[],
): Promise<ExtractedFile[]> {
  const out: ExtractedFile[] = [];
  const BATCH = 50;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const units = await runDartdocJson(rootAbs, batch);
    for (const unit of units) {
      // dartdoc_json returns `source` as the path we passed (absolute with --root);
      // make it repo-relative so FQNs are clean (lib.src.widgets..., not .Users...).
      const raw = unit.source || join(rootAbs, batch[i]!);
      const relPath = raw.startsWith(rootAbs) ? raw.slice(rootAbs.length).replace(/^[/\\]/, "") : raw;
      // File-scoped module prefix — prepended to ALL top-level declarations so
      // their FQNs are unique across files (else `main`, `setUp`, etc. collide
      // on (fqn, start_line) across test files). Matches tree-sitter's behavior.
      const prefix = relPath
        .replace(/\.dart$/i, "")
        .replace(/[\\/]/g, ".")
        .replace(/\.index$/i, "");

      // Parallel tree-sitter-dart pass, purely to recover real source/line/byte
      // spans — dartdoc_json's analyzer output has neither. See buildDecl/countFqns.
      let tsByFqn: Map<string, SymbolNode> | undefined;
      const dupFqns = new Set<string>();
      try {
        const source = await readSource(rootAbs, relPath);
        const ex = await extractFile(relPath, source);
        if (ex) tsByFqn = new Map(ex.symbols.filter((s) => s.kind !== "module").map((s) => [s.fqn, s]));
      } catch {
        tsByFqn = undefined; // best-effort; dartdoc_json's own output still stands without it
      }
      const fqnCounts = new Map<string, number>();
      for (const d of unit.declarations ?? []) countFqns(d, prefix, fqnCounts);
      for (const [fqn, count] of fqnCounts) if (count > 1) dupFqns.add(fqn);

      const built: BuiltFile = { symbols: [], edges: [], line: 1 };
      for (const d of unit.declarations ?? []) buildDecl(d, prefix, relPath, built, tsByFqn, dupFqns);

      // module symbol anchor (for graph top-level refs)
      built.symbols.push({
        key: symbolKey(relPath, prefix),
        fqn: prefix,
        name: prefix.split(".").pop() ?? prefix,
        kind: "module",
        language: "dart",
        filePath: relPath,
        startLine: 0,
        endLine: 0,
        startByte: 0,
        endByte: 0,
        source: "",
        contentHash: sha256(`module:${prefix}`),
        isExported: true,
      });

      out.push({
        path: relPath,
        language: "dart",
        contentHash: sha256("__dartdoc__:" + relPath),
        loc: 0,
        sizeBytes: 0,
        symbols: built.symbols,
        edges: built.edges,
      });
    }
  }
  return out;
}
