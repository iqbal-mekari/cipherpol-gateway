import assert from "node:assert/strict";
import test from "node:test";
import { parseOptions } from "../src/args.js";
import { CliError } from "../src/errors.js";

function usageError(message: RegExp): (error: unknown) => boolean {
  return (error: unknown) => error instanceof CliError && error.code === "USAGE" && message.test(error.message);
}

test("parseOptions errors on a trailing value flag with no value", () => {
  assert.throws(() => parseOptions(["--registry"]), usageError(/--registry requires a value/));
});

test("parseOptions does not treat a following flag as the value", () => {
  assert.throws(() => parseOptions(["--registry", "--yes"]), usageError(/--registry requires a value/));
  assert.throws(() => parseOptions(["--capability", "--claude-version", "2.1.89"]), usageError(/--capability requires a value/));
});

test("parseOptions rejects the --flag=value compact form as an unknown option", () => {
  assert.throws(() => parseOptions(["--claude-version=2.1.89"]), usageError(/Unknown option: --claude-version=2\.1\.89/));
});

test("parseOptions rejects unknown flags", () => {
  assert.throws(() => parseOptions(["--bogus"]), usageError(/Unknown option: --bogus/));
});

test("parseOptions parses a happy path and accumulates repeated --capability", () => {
  const options = parseOptions([
    "--claude-version", "2.1.89",
    "--capability", "plugins",
    "--capability", "hooks",
    "--registry", "/tmp/registry",
    "--yes",
  ]);
  assert.deepEqual(options.values.get("--claude-version"), ["2.1.89"]);
  assert.deepEqual(options.values.get("--capability"), ["plugins", "hooks"]);
  assert.deepEqual(options.values.get("--registry"), ["/tmp/registry"]);
  assert.equal(options.flags.has("--yes"), true);
  assert.equal(options.flags.has("--check"), false);
  assert.equal(options.values.get("--source-root"), undefined);
});
