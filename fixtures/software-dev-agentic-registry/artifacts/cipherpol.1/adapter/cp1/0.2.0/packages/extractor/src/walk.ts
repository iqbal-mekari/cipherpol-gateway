import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import ignore from "ignore";
import { isSupported } from "./languages.js";

type Ignore = ReturnType<typeof ignore>;

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
  "vendor",
  "coverage",
  // iOS / Swift
  "Pods",
  "Carthage",
  "DerivedData",
  ".build",
  "build",
  ".swiftpm",
  // tests (opt-out via KB_INCLUDE_TESTS=1)
  "TalentaTests",
  "__Tests__",
  "Tests",
  // Android tests
  "androidTest",
  "test",
  // Mason CLI brick templates (Mustache-style scaffolding, e.g.
  // "{{name.snakeCase()}}.dart") — not valid source, just templates.
  "__brick__",
]);

// File-name patterns to skip (generated code). Opt out via KB_INCLUDE_GENERATED=1.
const SKIP_FILES = [
  /\.generated\.swift$/i, // *.generated.swift
  /(^|[\\/_])r\.generated\.swift$/i, // R.generated.swift (Rswift)
  /(^|[\\/_])needlegenerated\.swift$/i, // Needle DI scaffolding
  /(^|[\\/_])generated\.swift$/i,
  // Android generated files (R.java, BuildConfig.java/kt, *Binding.java/kt)
  /(^|[\\/_])R\.java$/,
  /(^|[\\/_])R\.kt$/,
  /(^|[\\/_])BuildConfig\.java$/,
  /(^|[\\/_])BuildConfig\.kt$/,
  /Binding\.(java|kt)$/,
];

const SKIP_MOCKS = /(^|[\\/_])(mock|stub|fake|dummy)[a-z0-9_]*\.swift$/i;

// Non-app source files (CI/tooling/manifests) to skip when trimming to app code.
const SKIP_NONAPP = [
  /(^|[\\/_])dangerfile\.swift$/i,
  /(^|[\\/_])brewfile\.swift$/i,
  /(^|[\\/_])package\.swift$/i, // SPM manifest (not app logic)
];

// Known-sensitive files/dirs (secrets, keys, credentials) — always excluded from
// indexing regardless of .gitignore, since a repo's gitignore may not cover every
// secret shape and we never want key material embedded or persisted. Opt out via
// KB_INCLUDE_SENSITIVE=1 if a match is a false positive for your repo.
const SENSITIVE_DIRS = new Set([".ssh", ".aws", ".gnupg", "secrets", "private_keys"]);

const SENSITIVE_FILES = [
  /(^|[\\/])\.env(\.[^\\/]+)?$/i, // .env, .env.local, .env.production, ...
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])\.pgpass$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|p8)$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|[\\/])(.*[-_.])?credentials\.(json|ya?ml)$/i,
  /(^|[\\/])service[-_]?account.*\.json$/i,
  /(^|[\\/])secrets?\.(json|ya?ml|env)$/i,
  /(^|[\\/])\.mobileprovision$/i,
  // Firebase/Google config files (API keys, project + client IDs).
  /(^|[\\/])GoogleService-Info\.plist$/i,
  /(^|[\\/])google-services\.json$/i,
  // FlutterFire CLI-generated Firebase config (real per-platform apiKey values) —
  // a .dart file, so it's otherwise fully parsed as ordinary supported source.
  /(^|[\\/])firebase_options\.dart$/i,
  // Gradle/Android/Flutter signing config — keystore alias + store/key passwords.
  /(^|[\\/])key(store)?\.properties$/i,
  /(^|[\\/])signing\.properties$/i,
  // Android local SDK/NDK path file, also a common dumping ground for API keys
  // (e.g. MAPS_API_KEY) since it's gitignored by convention in most templates.
  /(^|[\\/])local\.properties$/i,
  // Yarn registry config — can carry an npmAuthToken for private registries.
  /(^|[\\/])\.yarnrc(\.yml)?$/i,
  // Whole-basename matches for source files (e.g. Secrets.swift, ApiKeys.kt) that
  // conventionally hold hardcoded keys/tokens. Deliberately whole-name, not a
  // substring match, so ordinary app code like "CredentialsRepository.kt" or
  // "SecretsManagerClient.ts" is left alone.
  /(^|[\\/])(secrets?|api[-_]?keys?|credentials?)\.[a-z0-9]+$/i,
];

function isSensitive(relPath: string, name: string): boolean {
  if (process.env.KB_INCLUDE_SENSITIVE === "1") return false;
  return SENSITIVE_FILES.some((re) => re.test(relPath) || re.test(name));
}

function isSensitiveDir(name: string): boolean {
  return process.env.KB_INCLUDE_SENSITIVE !== "1" && SENSITIVE_DIRS.has(name.toLowerCase());
}

/** True if a file/dir name should be skipped per the current exclude rules. */
function shouldSkip(relPath: string, name: string): boolean {
  if (process.env.KB_INCLUDE_GENERATED !== "1" && SKIP_FILES.some((re) => re.test(relPath) || re.test(name))) {
    return true;
  }
  if (isSensitive(relPath, name)) return true;
  if (process.env.KB_INCLUDE_TESTS === "1") return false; // keep tests if opted in
  if (IGNORE_DIRS.has(name)) return true; // test dirs above already handle this
  if (process.env.KB_INCLUDE_MOCKS !== "1" && SKIP_MOCKS.test(relPath)) return true;
  if (process.env.KB_INCLUDE_NONAPP !== "1" && SKIP_NONAPP.some((re) => re.test(relPath) || re.test(name))) {
    return true;
  }
  return false;
}

/** Rewrite a raw .gitignore line so it applies scoped to the directory (relative
 *  to the walk root) that the .gitignore file lives in, per gitignore semantics:
 *  a pattern anchored with a leading/middle slash is relative to that directory;
 *  otherwise it matches at any depth below it. */
function scopeGitignoreLine(line: string, dirRel: string): string {
  if (!dirRel) return line;
  const negate = line.startsWith("!");
  let body = negate ? line.slice(1) : line;
  const anchored = body.startsWith("/");
  if (anchored) body = body.slice(1);
  const hasMiddleSlash = body.replace(/\/$/, "").includes("/");
  const scoped = anchored || hasMiddleSlash ? `${dirRel}/${body}` : `${dirRel}/**/${body}`;
  return negate ? `!${scoped}` : scoped;
}

/** Recursively yield repo-relative paths of supported source files under root,
 *  skipping generated code, tests, and mocks by default (override via env).
 *  Also honors every .gitignore found in the tree (nested ones scoped to their
 *  own directory) and a fixed set of known-sensitive files, unless opted out. */
export async function walkSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const respectGitignore = process.env.KB_INCLUDE_GITIGNORED !== "1";
  const ig: Ignore = ignore();

  async function loadGitignore(dir: string, dirRel: string): Promise<void> {
    if (!respectGitignore) return;
    try {
      const content = await readFile(join(dir, ".gitignore"), "utf8");
      for (const raw of content.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        ig.add(scopeGitignoreLine(line, dirRel));
      }
    } catch {
      // no .gitignore at this level — fine
    }
  }

  async function recurse(dir: string, dirRel: string): Promise<void> {
    await loadGitignore(dir, dirRel);
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === ".git") continue;
      const full = join(dir, e.name);
      const rel = relative(root, full);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        if (isSensitiveDir(e.name)) continue;
        if (respectGitignore && ig.ignores(`${rel}/`)) continue;
        await recurse(full, rel);
      } else if (e.isFile() && isSupported(full)) {
        if (respectGitignore && ig.ignores(rel)) continue;
        if (shouldSkip(rel, e.name)) continue;
        out.push(rel);
      }
    }
  }
  await recurse(root, "");
  return out;
}

export async function readSource(root: string, relPath: string): Promise<string> {
  return readFile(join(root, relPath), "utf8");
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
