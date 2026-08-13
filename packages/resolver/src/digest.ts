import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

async function files(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory()
    ? files(root, join(dir, entry.name)) : [join(dir, entry.name)])))
    .flat().sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
}

export async function digestDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await files(root)) {
    hash.update(relative(root, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
