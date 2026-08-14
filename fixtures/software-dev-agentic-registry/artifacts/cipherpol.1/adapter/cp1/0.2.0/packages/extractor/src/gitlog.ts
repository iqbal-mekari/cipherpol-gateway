import { spawn } from "node:child_process";

/** Lightweight per-file git provenance: the last commit that touched a path. */
export interface FileProvenance {
  commitHash: string;
  author: string;
  /** Author date, ISO 8601. */
  date: string;
  /** Commit message subject line only — no body, no Jira/PR parsing. */
  subject: string;
}

// Non-printable separators: a repo path or commit subject will never contain
// these, so parsing below needs no escaping.
const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";

function runGitLog(root: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["log", "--name-only", "--no-renames", `--format=${RECORD_SEP}%H${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%s`],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`git log exited ${code}: ${stderr.trim()}`))));
  });
}

/**
 * One-shot `git log` over the full history of `root`, mapping each repo-relative
 * path to the most recent commit that touched it. `git log` lists commits newest
 * first, so the first time a path is seen wins — no need to sort by date.
 *
 * Deliberately ONE process for the whole repo rather than `git log -1 -- <path>`
 * per file (which would mean one spawn per indexed file, easily thousands on a
 * mobile app repo). The tradeoff is walking full history once, which can be a
 * non-trivial amount of output on very long-lived repos — acceptable for
 * provenance metadata that's best-effort, not a hard indexing requirement.
 *
 * Returns an empty map (never throws) if `root` isn't a git repo, has no commits
 * yet, or `git` isn't on PATH.
 */
export async function fileProvenance(root: string): Promise<Map<string, FileProvenance>> {
  const map = new Map<string, FileProvenance>();
  let out: string;
  try {
    out = await runGitLog(root);
  } catch {
    return map;
  }

  let current: FileProvenance | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith(RECORD_SEP)) {
      const [hash, author, date, subject] = line.slice(RECORD_SEP.length).split(FIELD_SEP);
      current = { commitHash: hash ?? "", author: author ?? "", date: date ?? "", subject: subject ?? "" };
      continue;
    }
    const path = line.trim();
    if (!path || !current) continue;
    if (!map.has(path)) map.set(path, current);
  }
  return map;
}
