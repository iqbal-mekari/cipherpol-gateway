import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalArtifactDigest } from "@cipherpol/contracts";
import { CipherpolError, digestDirectory } from "../src/index.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cipherpol-digest-"));
}

test("digest matches the canonical artifact digest of the collected regular files", async () => {
  const root = await tempDir();
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "z-top.md"), "top level");
  await writeFile(join(root, "nested", "a-child.md"), "nested child");

  const actual = await digestDirectory(root);

  // Independently reconstruct the file set the way admission's artifact collection
  // would (walking the tree and reading raw bytes) and hand it to the same shared
  // canonical primitive, without importing @cipherpol/admission.
  const expected = canonicalArtifactDigest([
    { path: "z-top.md", bytes: await readFile(join(root, "z-top.md")) },
    { path: "nested/a-child.md", bytes: await readFile(join(root, "nested", "a-child.md")) },
  ]);

  assert.equal(actual, expected);
});

test("digest is independent of filesystem read order", async () => {
  const root = await tempDir();
  await writeFile(join(root, "b.md"), "b");
  await writeFile(join(root, "a.md"), "a");

  const other = await tempDir();
  await writeFile(join(other, "a.md"), "a");
  await writeFile(join(other, "b.md"), "b");

  assert.equal(await digestDirectory(root), await digestDirectory(other));
});

test("rejects a symlinked file instead of excluding or following it", async () => {
  const root = await tempDir();
  await writeFile(join(root, "real.md"), "real content");

  const decoyTarget = await tempDir();
  await writeFile(join(decoyTarget, "decoy.md"), "totally different content");
  await symlink(join(decoyTarget, "decoy.md"), join(root, "link.md"));

  await assert.rejects(
    digestDirectory(root),
    (error: unknown) => error instanceof CipherpolError && error.code === "UNSAFE_ARTIFACT_FILE",
    "a symlink must be rejected, never silently skipped or followed",
  );
});

test("rejects a symlinked directory instead of excluding or following it", async () => {
  const root = await tempDir();
  await writeFile(join(root, "real.md"), "real content");

  const decoyDir = await tempDir();
  await mkdir(join(decoyDir, "sub"), { recursive: true });
  await writeFile(join(decoyDir, "sub", "file.md"), "decoy directory content");
  await symlink(decoyDir, join(root, "linked-dir"));

  await assert.rejects(
    digestDirectory(root),
    (error: unknown) => error instanceof CipherpolError && error.code === "UNSAFE_ARTIFACT_FILE",
    "a symlinked directory must be rejected, never silently skipped or traversed",
  );
});
