import assert from "node:assert/strict";
import test from "node:test";
import { CipherpolAdmissionError } from "../src/index.js";

test("creates structured admission error with code and details", () => {
  const error = new CipherpolAdmissionError("INVALID_NAMESPACE", "Bad namespace", { id: "bad-id" });
  assert.equal(error.name, "CipherpolAdmissionError");
  assert.equal(error.code, "INVALID_NAMESPACE");
  assert.equal(error.details["id"], "bad-id");
  assert.equal(error.message, "Bad namespace");
});
