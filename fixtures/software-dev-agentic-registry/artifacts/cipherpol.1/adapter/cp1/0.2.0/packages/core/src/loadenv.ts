/**
 * Loads repo-root env files into process.env as a side effect on import.
 * Resolved relative to THIS module (not cwd), so every entrypoint — CLIs,
 * scripts, and the MCP server (which Claude Code may launch from anywhere) —
 * gets the same config.
 *
 * Precedence (first-set wins, existing env always wins over files):
 *   ambient process.env  >  .env.local  >  .env
 * `.env.local` is the developer-local override (gitignored) and is read first.
 *
 * Imported by config.ts, so simply using `config` loads the env.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."); // repo root

function loadEnvFile(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return; // file absent — rely on ambient env / other files
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile(join(root, ".env.local")); // dev-local override wins over .env
loadEnvFile(join(root, ".env"));
