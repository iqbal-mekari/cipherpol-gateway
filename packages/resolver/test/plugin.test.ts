import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const plugin = resolve("../../plugins/cipherpol");
for (const operation of ["setup", "update"]) {
  test(`ships cipherpol-${operation}`, async () => {
    const body = await readFile(resolve(plugin, `commands/cipherpol-${operation}.md`), "utf8");
    assert.match(body, new RegExp(`cipherpol-local ${operation}`));
  });
}
test("doctor delegates to read-only update check", async () => {
  assert.match(await readFile(resolve(plugin, "commands/cipherpol-doctor.md"), "utf8"), /cipherpol-local update --check/);
});
test("rollback is honest about the Stage 1 boundary", async () => {
  const body = await readFile(resolve(plugin, "commands/cipherpol-rollback.md"), "utf8");
  assert.match(body, /Rollback is introduced in Stage 4/);
  assert.doesNotMatch(body, /cipherpol-local rollback/);
});
test("bootstrap excludes runtime agents and skills", async () => {
  await assert.rejects(access(resolve(plugin, "agents")));
  await assert.rejects(access(resolve(plugin, "skills")));
});
