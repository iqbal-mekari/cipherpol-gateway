import { Parser, Language, Query, type Tree } from "web-tree-sitter";
import { languageForPath, type LanguageDef } from "./languages.js";

let initialized = false;
const langCache = new Map<string, Language>();
const queryCache = new Map<string, Query>();

async function ensureInit(): Promise<void> {
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }
}

async function loadLanguage(def: LanguageDef): Promise<Language> {
  const cached = langCache.get(def.id);
  if (cached) return cached;
  const lang = await Language.load(def.wasmPath);
  langCache.set(def.id, lang);
  return lang;
}

export interface ParsedFile {
  def: LanguageDef;
  tree: Tree;
  query: Query;
  source: string;
}

/**
 * Parse a source file into a tree + its tagging query. Returns null for
 * unsupported extensions. The Tree must be released by the caller via
 * `parsed.tree.delete()` when done (web-tree-sitter holds wasm memory).
 */
export async function parseFile(path: string, source: string): Promise<ParsedFile | null> {
  const def = languageForPath(path);
  if (!def) return null;

  await ensureInit();
  const lang = await loadLanguage(def);

  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  parser.delete();
  if (!tree) return null;

  let query = queryCache.get(def.id);
  if (!query) {
    query = new Query(lang, def.query);
    queryCache.set(def.id, query);
  }

  return { def, tree, query, source };
}
