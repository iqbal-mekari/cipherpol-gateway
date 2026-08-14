import type { Node, Query } from "web-tree-sitter";
import {
  type SymbolNode,
  type EdgeRel,
  type SymbolKind,
  type EdgeKind,
  type ExtractedFile,
  sha256,
  symbolKey,
} from "@kb/core";
import { parseFile } from "./parser.js";
import type { LanguageDef } from "./languages.js";

const KIND_PRIORITY: Record<string, number> = {
  class: 6,
  interface: 6,
  enum: 5,
  type: 5,
  method: 4,
  function: 3,
  const: 1,
  module: 0,
};

/** Path → dotted module prefix, e.g. "src/auth/login.ts" → "src.auth.login". */
function modulePrefix(path: string): string {
  return path
    .replace(/\.(d\.ts|tsx?|jsx?|mts|cts|mjs|cjs|pyi?|dart|swift|kts?|java)$/i, "")
    .replace(/[\\/]/g, ".")
    .replace(/\.index$/i, "");
}

/** Outer→inner names of enclosing scope nodes (class/namespace/function) above `node`. */
function enclosingScopeNames(node: Node, scopeTypes: Set<string>): string[] {
  const names: string[] = [];
  let cur = node.parent;
  while (cur) {
    if (scopeTypes.has(cur.type)) {
      const nameNode = cur.childForFieldName("name");
      if (nameNode) names.unshift(nameNode.text);
    }
    cur = cur.parent;
  }
  return names;
}

function defFqn(prefix: string, node: Node, ownName: string, scopeTypes: Set<string>): string {
  return [prefix, ...enclosingScopeNames(node, scopeTypes), ownName].filter(Boolean).join(".");
}

/** Nearest enclosing named definition node (the "owner" of a reference). */
function enclosingDef(node: Node, scopeTypes: Set<string>): Node | null {
  let cur = node.parent;
  while (cur) {
    if (scopeTypes.has(cur.type) && cur.childForFieldName("name")) return cur;
    cur = cur.parent;
  }
  return null;
}

/** Consecutive leading line/block comments immediately above a node. */
function leadingDoc(node: Node): string | undefined {
  const parts: string[] = [];
  let prev = node.previousSibling;
  while (prev && prev.type === "comment") {
    parts.unshift(prev.text);
    prev = prev.previousSibling;
  }
  return parts.length ? parts.join("\n") : undefined;
}

/** First line of a definition up to the body opener — a cheap signature. */
function signatureOf(node: Node, source: string): string {
  const slice = source.slice(node.startIndex, node.endIndex);
  const brace = slice.indexOf("{");
  const colon = slice.indexOf(":\n"); // python def header end
  let end = slice.length;
  if (brace >= 0) end = Math.min(end, brace);
  if (colon >= 0) end = Math.min(end, colon + 1);
  return slice.slice(0, end).replace(/\s+/g, " ").trim().slice(0, 400);
}

function isInsideFunctionBody(node: Node): boolean {
  let cur = node.parent;
  while (cur) {
    if (
      cur.type === "function_declaration" ||
      cur.type === "method_definition" ||
      cur.type === "arrow_function" ||
      cur.type === "function_expression" ||
      cur.type === "function_definition"
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

const REF_KINDS: Record<string, EdgeKind> = {
  "ref.calls": "calls",
  "ref.extends": "extends",
  "ref.implements": "implements",
  "ref.imports": "imports",
  "ref.references": "references",
};

/**
 * Extract symbols + edges from already-parsed source. Pure over the tree;
 * resolution of edge targets across files happens later in resolve.ts.
 */
export function extractFromTree(
  path: string,
  source: string,
  def: LanguageDef,
  rootNode: Node,
  query: Query,
): { symbols: SymbolNode[]; edges: EdgeRel[] } {
  const prefix = modulePrefix(path);
  const scopeTypes = def.scopeTypes;
  const symbolsByKey = new Map<string, SymbolNode>();
  const edgeSet = new Map<string, EdgeRel>();

  // Always emit a module-scope symbol — file-level chunk + anchor for top-level refs.
  const moduleKey = symbolKey(path, prefix);
  symbolsByKey.set(moduleKey, {
    key: moduleKey,
    fqn: prefix,
    name: prefix.split(".").pop() ?? prefix,
    kind: "module",
    language: def.id,
    filePath: path,
    startLine: 0,
    endLine: rootNode.endPosition.row,
    startByte: 0,
    endByte: rootNode.endIndex,
    source: "",
    contentHash: sha256(`module:${prefix}`),
    isExported: true,
  });

  for (const match of query.matches(rootNode)) {
    const nameCap = match.captures.find((c) => c.name === "name");
    const defCap = match.captures.find((c) => c.name.startsWith("def."));
    const refCap = match.captures.find((c) => c.name.startsWith("ref."));
    if (!nameCap) continue;
    const name = nameCap.node.text;

    if (defCap) {
      const kind = defCap.name.slice("def.".length) as SymbolKind;
      const node = defCap.node;
      if (kind === "const" && isInsideFunctionBody(node)) continue; // skip noisy locals
      const fqn = defFqn(prefix, node, name, scopeTypes);
      const key = symbolKey(path, fqn);
      const src = source.slice(node.startIndex, node.endIndex);
      const candidate: SymbolNode = {
        key,
        fqn,
        name,
        kind,
        language: def.id,
        filePath: path,
        signature: signatureOf(node, source),
        startLine: node.startPosition.row,
        endLine: node.endPosition.row,
        startByte: node.startIndex,
        endByte: node.endIndex,
        docComment: leadingDoc(node),
        source: src,
        contentHash: sha256(src),
        isExported: /\bexport\b/.test(source.slice(Math.max(0, node.startIndex - 12), node.startIndex)),
      };
      const existing = symbolsByKey.get(key);
      if (!existing || (KIND_PRIORITY[kind] ?? 0) > (KIND_PRIORITY[existing.kind] ?? 0)) {
        symbolsByKey.set(key, candidate);
      }
    } else if (refCap) {
      const kind = REF_KINDS[refCap.name];
      if (!kind) continue;
      const owner = enclosingDef(refCap.node, scopeTypes);
      const srcFqn = owner
        ? defFqn(prefix, owner, owner.childForFieldName("name")!.text, scopeTypes)
        : prefix;
      const srcKey = symbolKey(path, srcFqn);
      const dstFqn = name;
      if (dstFqn === srcFqn) continue; // ignore self-reference noise
      const ek = `${srcKey}|${dstFqn}|${kind}`;
      if (!edgeSet.has(ek)) edgeSet.set(ek, { srcKey, dstFqn, kind });
    }
  }

  return { symbols: [...symbolsByKey.values()], edges: [...edgeSet.values()] };
}

/** Parse + extract a single file. Returns null for unsupported languages. */
export async function extractFile(path: string, source: string): Promise<ExtractedFile | null> {
  const parsed = await parseFile(path, source);
  if (!parsed) return null;
  try {
    const { symbols, edges } = extractFromTree(path, source, parsed.def, parsed.tree.rootNode, parsed.query);
    return {
      path,
      language: parsed.def.id,
      contentHash: sha256(source),
      loc: source.split("\n").length,
      sizeBytes: Buffer.byteLength(source, "utf8"),
      symbols,
      edges,
    };
  } finally {
    parsed.tree.delete();
  }
}
