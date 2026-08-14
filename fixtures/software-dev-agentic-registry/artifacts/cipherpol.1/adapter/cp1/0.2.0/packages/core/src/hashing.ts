import { createHash } from "node:crypto";

/** sha256 hex of a string or buffer. Used for content-addressing files, symbols, chunks. */
export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Stable symbol identity = hash(filePath + "::" + fqn). Deliberately excludes
 * line numbers so whitespace edits above a symbol don't change its identity
 * (only its contentHash changes, which is what gates re-embedding).
 */
export function symbolKey(filePath: string, fqn: string): string {
  return sha256(`${filePath}::${fqn}`);
}
