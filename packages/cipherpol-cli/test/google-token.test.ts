import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getGoogleIdToken } from "../src/google-token.js";

test("reports an actionable gcloud login error when gcloud is missing", async () => {
  const previousPath = process.env.PATH;
  const empty = await mkdtemp(join(tmpdir(), "cipherpol-no-gcloud-"));
  process.env.PATH = empty;
  try {
    await assert.rejects(
      getGoogleIdToken(),
      (error: unknown) => error instanceof Error && /gcloud auth login/.test(error.message),
    );
  } finally {
    process.env.PATH = previousPath;
  }
});
