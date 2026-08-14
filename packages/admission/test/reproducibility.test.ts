import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { CipherpolAdmissionError } from "../src/errors.js";
import { compareClosureTrees } from "../src/reproducibility.js";

async function tree(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cipherpol-reproducibility-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeTreeFile(root: string, relativePath: string, contents: string, mode = 0o644): Promise<void> {
  const filePath = join(root, ...relativePath.split("/"));
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, contents, "utf8");
  await chmod(filePath, mode);
}

function assertReproducibilityMismatch(error: unknown, path: string): boolean {
  assert.ok(error instanceof CipherpolAdmissionError);
  assert.equal(error.code, "REPRODUCIBILITY_MISMATCH");
  assert.equal(error.details["path"], path);
  return true;
}

test("succeeds silently when two trees have identical relative paths, bytes, and modes", async (t) => {
  const left = await tree(t);
  const right = await tree(t);
  await Promise.all([
    writeTreeFile(left, "artifacts/a/one.md", "one", 0o644),
    writeTreeFile(left, "artifacts/b/two.sh", "two", 0o755),
    writeTreeFile(right, "artifacts/a/one.md", "one", 0o644),
    writeTreeFile(right, "artifacts/b/two.sh", "two", 0o755),
  ]);

  await assert.doesNotReject(compareClosureTrees(left, right));
});

test("throws REPRODUCIBILITY_MISMATCH reporting the first missing path in code-point order", async (t) => {
  const left = await tree(t);
  const right = await tree(t);
  await Promise.all([
    writeTreeFile(left, "artifacts/a/one.md", "one"),
    writeTreeFile(left, "artifacts/z/extra.md", "extra"),
    writeTreeFile(right, "artifacts/a/one.md", "one"),
  ]);

  await assert.rejects(
    compareClosureTrees(left, right),
    (error) => assertReproducibilityMismatch(error, "artifacts/z/extra.md"),
  );
});

test("throws REPRODUCIBILITY_MISMATCH reporting a byte digest divergence", async (t) => {
  const left = await tree(t);
  const right = await tree(t);
  await Promise.all([
    writeTreeFile(left, "artifacts/a/one.md", "left-bytes"),
    writeTreeFile(right, "artifacts/a/one.md", "right-bytes"),
  ]);

  await assert.rejects(
    compareClosureTrees(left, right),
    (error) => assertReproducibilityMismatch(error, "artifacts/a/one.md"),
  );
});

test("throws REPRODUCIBILITY_MISMATCH reporting a mode divergence with identical bytes", async (t) => {
  const left = await tree(t);
  const right = await tree(t);
  await Promise.all([
    writeTreeFile(left, "artifacts/a/one.sh", "same", 0o644),
    writeTreeFile(right, "artifacts/a/one.sh", "same", 0o755),
  ]);

  await assert.rejects(
    compareClosureTrees(left, right),
    (error) => {
      assert.ok(error instanceof CipherpolAdmissionError);
      assert.equal(error.code, "REPRODUCIBILITY_MISMATCH");
      assert.equal(error.details["path"], "artifacts/a/one.sh");
      assert.equal(error.details["leftMode"], 0o644);
      assert.equal(error.details["rightMode"], 0o755);
      return true;
    },
  );
});

test("reports the code-point-first divergence deterministically regardless of walk order", async (t) => {
  const left = await tree(t);
  const right = await tree(t);
  await Promise.all([
    writeTreeFile(left, "artifacts/m/middle.md", "value"),
    writeTreeFile(left, "artifacts/z/last.md", "left-value"),
    writeTreeFile(right, "artifacts/m/middle.md", "value"),
    writeTreeFile(right, "artifacts/z/last.md", "right-value"),
  ]);

  await assert.rejects(
    compareClosureTrees(left, right),
    (error) => assertReproducibilityMismatch(error, "artifacts/z/last.md"),
  );
});

test("rejects a symbolic link with UNSAFE_ARTIFACT_FILE instead of comparing through it", async (t) => {
  const left = await tree(t);
  const right = await tree(t);
  await writeTreeFile(left, "artifacts/target.md", "value");
  await symlink(join(left, "artifacts", "target.md"), join(left, "artifacts", "link.md"));
  await writeTreeFile(right, "artifacts/target.md", "value");
  await writeTreeFile(right, "artifacts/link.md", "value");

  await assert.rejects(compareClosureTrees(left, right), (error) => {
    assert.ok(error instanceof CipherpolAdmissionError);
    assert.equal(error.code, "UNSAFE_ARTIFACT_FILE");
    assert.equal(error.details["path"], "artifacts/link.md");
    return true;
  });
});

test("compares nested directory structures recursively", async (t) => {
  const left = await tree(t);
  const right = await tree(t);
  await Promise.all([
    writeTreeFile(left, "admissions/nested/deep/record.json", "{}"),
    writeTreeFile(right, "admissions/nested/deep/record.json", "{}"),
  ]);

  await assert.doesNotReject(compareClosureTrees(left, right));
});

test("rejects a file that changes between the initial stat and the read instead of comparing stale bytes", async (t) => {
  const left = await tree(t);
  const right = await tree(t);
  const mutatingFilePath = join(left, "artifacts", "mutating.md");
  await Promise.all([
    writeTreeFile(left, "artifacts/mutating.md", "original"),
    writeTreeFile(right, "artifacts/mutating.md", "original"),
  ]);

  const probe = await open(mutatingFilePath, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probe) as { readFile(): Promise<Buffer> };
  const originalReadFile = fileHandlePrototype.readFile;
  await probe.close();
  fileHandlePrototype.readFile = async function readAndMutate(this: unknown): Promise<Buffer> {
    const content = await originalReadFile.call(this);
    await appendFile(mutatingFilePath, "mutated", "utf8");
    return content;
  };

  try {
    await assert.rejects(compareClosureTrees(left, right), (error) => {
      assert.ok(error instanceof CipherpolAdmissionError);
      assert.equal(error.code, "UNSAFE_ARTIFACT_FILE");
      assert.equal(error.details["reason"], "changed-during-collection");
      assert.equal(error.details["path"], "artifacts/mutating.md");
      return true;
    });
  } finally {
    fileHandlePrototype.readFile = originalReadFile;
  }
});
