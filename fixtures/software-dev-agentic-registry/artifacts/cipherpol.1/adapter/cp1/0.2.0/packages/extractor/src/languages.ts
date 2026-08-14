import { createRequire } from "node:module";
import { extname, basename } from "node:path";
import { TYPESCRIPT_QUERY, JAVASCRIPT_QUERY, PYTHON_QUERY, DART_QUERY, SWIFT_QUERY, KOTLIN_QUERY, JAVA_QUERY } from "./queries.js";

const require = createRequire(import.meta.url);

export interface LanguageDef {
  /** Canonical language id stored in the DB. */
  id: string;
  /** Absolute path to the grammar .wasm (resolved from tree-sitter-wasms). */
  wasmPath: string;
  /** Tagging query source. */
  query: string;
  /** tree-sitter node types that introduce an FQN scope (class/namespace/function). */
  scopeTypes: Set<string>;
  /** node types treated as a "method" container so methods get class-qualified. */
}

/** Resolve a grammar wasm from the tree-sitter-wasms package, layout-agnostic. */
function wasm(name: string): string {
  return require.resolve(`tree-sitter-wasms/out/tree-sitter-${name}.wasm`);
}

const TS_SCOPES = new Set([
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "enum_declaration",
  "function_declaration",
  "generator_function_declaration",
  "method_definition",
  "module",
  "internal_module",
  "namespace",
]);

const PY_SCOPES = new Set(["class_definition", "function_definition"]);

const DART_SCOPES = new Set([
  "class_definition",
  "enum_declaration",
  "class_body",
  "mixin_declaration",
  "extension_declaration",
]);

const SWIFT_SCOPES = new Set([
  "class_declaration",
  "struct_declaration",
  "actor_declaration",
  "enum_declaration",
  "protocol_declaration",
  "extension_declaration",
  "class_body",
  "struct_body",
  "enum_body",
  "protocol_body",
]);

const KOTLIN_SCOPES = new Set([
  "class_declaration",
  "object_declaration",
  "companion_object",
  "function_declaration",
]);

const JAVA_SCOPES = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "method_declaration",
]);

const LANGUAGES: Record<string, LanguageDef> = {
  typescript: { id: "typescript", wasmPath: wasm("typescript"), query: TYPESCRIPT_QUERY, scopeTypes: TS_SCOPES },
  tsx: { id: "tsx", wasmPath: wasm("tsx"), query: TYPESCRIPT_QUERY, scopeTypes: TS_SCOPES },
  javascript: { id: "javascript", wasmPath: wasm("javascript"), query: JAVASCRIPT_QUERY, scopeTypes: TS_SCOPES },
  python: { id: "python", wasmPath: wasm("python"), query: PYTHON_QUERY, scopeTypes: PY_SCOPES },
  dart: { id: "dart", wasmPath: wasm("dart"), query: DART_QUERY, scopeTypes: DART_SCOPES },
  swift: { id: "swift", wasmPath: wasm("swift"), query: SWIFT_QUERY, scopeTypes: SWIFT_SCOPES },
  kotlin: { id: "kotlin", wasmPath: wasm("kotlin"), query: KOTLIN_QUERY, scopeTypes: KOTLIN_SCOPES },
  java: { id: "java", wasmPath: wasm("java"), query: JAVA_QUERY, scopeTypes: JAVA_SCOPES },
};

const EXT_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "tsx",
  ".py": "python",
  ".pyi": "python",
  ".dart": "dart",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".java": "java",
};

/** Map a file path to its LanguageDef, or null if unsupported. */
export function languageForPath(path: string): LanguageDef | null {
  const ext = extname(path).toLowerCase();
  // .d.ts files are declarations — skip to avoid duplicate symbols.
  if (basename(path).endsWith(".d.ts")) return null;
  const id = EXT_MAP[ext];
  return id ? LANGUAGES[id]! : null;
}

export function isSupported(path: string): boolean {
  return languageForPath(path) !== null;
}
