import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalArtifactDigest } from "../src/index.js";

const a = { path: "z/file.md", bytes: new Uint8Array([0x7a]) };
const b = { path: "A/file.md", bytes: new Uint8Array([0x61]) };

function framedDigest(files: ReadonlyArray<{ path: string; bytes: Uint8Array }>): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

test("canonical artifact digest is independent of input order", () => {
  assert.equal(canonicalArtifactDigest([a, b]), canonicalArtifactDigest([b, a]));
});

test("canonical artifact digest sorts paths by Unicode code point", () => {
  const privateUse = { path: "\ue000/file", bytes: new Uint8Array([1]) };
  const supplementary = { path: "\u{10000}/file", bytes: new Uint8Array([2]) };
  assert.equal(
    canonicalArtifactDigest([supplementary, privateUse]),
    framedDigest([privateUse, supplementary]),
  );
});

test("canonical artifact digest rejects duplicate paths", () => {
  assert.throws(() => canonicalArtifactDigest([a, a]), /duplicate artifact path/);
});

test("canonical artifact digest changes with bytes", () => {
  assert.notEqual(
    canonicalArtifactDigest([a]),
    canonicalArtifactDigest([{ ...a, bytes: new Uint8Array([0x63]) }]),
  );
});

test("canonical artifact digest rejects non-canonical or unsafe paths", () => {
  for (const path of ["", "/absolute", "back\\slash", ".", "./file", "a/./file", "../file", "a/../file", "a//file", "file/", "nul\0file"]) {
    assert.throws(
      () => canonicalArtifactDigest([{ path, bytes: new Uint8Array() }]),
      /normalized traversal-free POSIX path/,
      path,
    );
  }
});
