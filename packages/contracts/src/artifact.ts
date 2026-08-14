import { createHash } from "node:crypto";

export interface CanonicalArtifactFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

function compareCodePoints(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCodePoint = left.codePointAt(leftIndex)!;
    const rightCodePoint = right.codePointAt(rightIndex)!;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint - rightCodePoint;
    leftIndex += leftCodePoint > 0xffff ? 2 : 1;
    rightIndex += rightCodePoint > 0xffff ? 2 : 1;
  }

  return left.length - right.length;
}

function validateArtifactPath(path: string): void {
  if (
    path.length === 0
    || path.startsWith("/")
    || path.includes("\\")
    || path.includes("\0")
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`artifact path must be a normalized traversal-free POSIX path: ${path}`);
  }
}

export function canonicalArtifactDigest(files: readonly CanonicalArtifactFile[]): string {
  const ordered = [...files].sort((left, right) => compareCodePoints(left.path, right.path));
  const seen = new Set<string>();
  const hash = createHash("sha256");

  for (const file of ordered) {
    validateArtifactPath(file.path);
    if (seen.has(file.path)) throw new Error(`duplicate artifact path: ${file.path}`);
    seen.add(file.path);
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }

  return `sha256:${hash.digest("hex")}`;
}
