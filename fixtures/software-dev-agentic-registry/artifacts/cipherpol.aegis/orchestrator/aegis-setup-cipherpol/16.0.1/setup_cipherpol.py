#!/usr/bin/env python3
"""Idempotent file-safe setup for CipherPol — the bits with no `claude` CLI.

Handles exactly four things (MCP servers, marketplaces, and plugin enablement
are done by the SKILL via the `claude` CLI, which writes ~/.claude.json safely):

  1. `.claude/agentic-state/` run directory in the current project
  2. `agentic-state/` in the user's global gitignore
  3. the `env` block of ~/.claude/settings.json (CP1_AUTH_TOKEN placeholder,
     recommended toolkit flags; drops the removed CP8_ENABLE_LOGGING)
  4. a regenerable "how to invoke this toolkit" quick-start file, written to
     `.claude/cipherpol-invocation-rules.md` (or assimilated into an existing
     foreign `@...md` import already pointed to by CLAUDE.md/AGENTS.md), with
     a pointer line added to CLAUDE.md — or AGENTS.md when CLAUDE.md is a
     stub that only contains `@AGENTS.md`

Never overwrites a real value that is already set. Dependency-free, Python 3.9+.
Run with --dry-run to preview; without it to apply. Prints one status line per
action: DONE / SKIP / PLAN / WARN.
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys

HOME = os.path.expanduser("~")
SETTINGS = os.path.join(HOME, ".claude", "settings.json")
CP1_TOKEN_PLACEHOLDER = "<paste-your-CP1_AUTH_TOKEN-here>"

# env keys the setup ensures. value = default to write when the key is absent.
ENV_DEFAULTS = {
    "CP1_AUTH_TOKEN": CP1_TOKEN_PLACEHOLDER,
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "ENABLE_TOOL_SEARCH": "true",
}
# env keys to remove (belonged to the retired cp8).
ENV_REMOVE = ["CP8_ENABLE_LOGGING"]

# invocation-rules quick-start file (own copy, when no foreign import exists to
# assimilate into) and the delimiters used when assimilating into one that does.
OWN_REL = ".claude/cipherpol-invocation-rules.md"
BEGIN_MARKER = "<!-- BEGIN cipherpol-invocation-rules -->"
END_MARKER = "<!-- END cipherpol-invocation-rules -->"

# literal placeholder token in the invocation-rules template, replaced with the
# rendered skills table markdown when rendering the template into a fresh file.
SKILLS_TABLE_PLACEHOLDER = "<!-- CIPHERPOL_SKILLS_TABLE -->"
# name shape that distinguishes a CipherPol-authored skill row from a project's
# own local skill (or a cipherpol-1 `cp1-`-prefixed skill, out of scope here).
SKILL_NAME_RE = re.compile(r"^(aegis|developer|qa)-[a-z0-9-]+$")
SKILLS_TABLE_HEADER = "| When the user asks about… | Invoke this skill |\n|---|---|"

actions = []  # (status, message)


def record(status, message):
    actions.append((status, message))
    print(f"{status}: {message}")


def ensure_agentic_state(dry):
    path = os.path.join(os.getcwd(), ".claude", "agentic-state")
    if os.path.isdir(path):
        record("SKIP", f"agentic-state dir already exists: {path}")
        return
    if dry:
        record("PLAN", f"create run dir: {path}")
        return
    os.makedirs(path, exist_ok=True)
    record("DONE", f"created run dir: {path}")


def _infer_workspace_root():
    """Parent of the enclosing git repo — where sibling clones normally live."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, check=False, timeout=5,
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return None
    top = out.stdout.strip()
    return os.path.dirname(top) if out.returncode == 0 and top else None


def ensure_workspace_manifest(dry, roots):
    """Create/extend ~/.claude/cipherpol-workspace.json.

    Only ever adds workspace_roots — an existing root list, and the cached
    repos[] the resolver maintains, are never rewritten or reordered here.
    """
    path = os.path.join(HOME, ".claude", "cipherpol-workspace.json")

    data, existed = {}, os.path.isfile(path)
    if existed:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            record("WARN", f"workspace manifest unreadable, leaving untouched: {path}")
            return

    wanted = [r for r in (roots or []) if r]
    if not wanted and not existed:
        inferred = _infer_workspace_root()
        if inferred:
            wanted = [inferred]

    current = list(data.get("workspace_roots", []))
    normalized = {os.path.abspath(os.path.expanduser(r)) for r in current}
    added = [r for r in wanted if os.path.abspath(os.path.expanduser(r)) not in normalized]

    if existed and not added:
        record("SKIP", f"workspace manifest already covers those roots: {path}")
        return
    if not existed and not added:
        record("WARN", "no workspace root given or inferable — run again with "
                       "--workspace-root=<dir> if you keep repos side by side")
        return

    data.setdefault("schema_version", 1)
    data["workspace_roots"] = current + added
    verb, done = ("extend", "extended") if existed else ("create", "created")
    if dry:
        record("PLAN", f"{verb} workspace manifest {path} (+{', '.join(added)})")
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    record("DONE", f"{done} workspace manifest {path} (+{', '.join(added)})")


def _global_gitignore_path():
    try:
        out = subprocess.run(
            ["git", "config", "--global", "core.excludesfile"],
            capture_output=True, text=True, check=False,
        )
        val = out.stdout.strip()
    except FileNotFoundError:
        return None, False  # git not installed
    if val:
        return os.path.expanduser(val), True
    return os.path.join(HOME, ".gitignore_global"), False  # default, unset


def ensure_gitignore(dry):
    path, was_set = _global_gitignore_path()
    if path is None:
        record("WARN", "git not found — cannot configure global gitignore")
        return
    pattern = "agentic-state/"
    existing = ""
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as f:
            existing = f.read()
    has_pattern = any(
        line.strip() == pattern for line in existing.splitlines()
    )
    if has_pattern and was_set:
        record("SKIP", f"'{pattern}' already in global gitignore: {path}")
        return
    if dry:
        if not was_set:
            record("PLAN", f"set git core.excludesfile → {path}")
        if not has_pattern:
            record("PLAN", f"append '{pattern}' to {path}")
        return
    if not has_pattern:
        with open(path, "a", encoding="utf-8") as f:
            if existing and not existing.endswith("\n"):
                f.write("\n")
            f.write(pattern + "\n")
        record("DONE", f"appended '{pattern}' to {path}")
    if not was_set:
        subprocess.run(
            ["git", "config", "--global", "core.excludesfile", path],
            check=False,
        )
        record("DONE", f"set git core.excludesfile → {path}")


def ensure_settings_env(dry):
    if os.path.isfile(SETTINGS):
        try:
            with open(SETTINGS, "r", encoding="utf-8") as f:
                data = json.load(f)
        except json.JSONDecodeError:
            record("WARN", f"{SETTINGS} is not valid JSON — skipping env setup")
            return
    else:
        data = {}
    env = data.get("env", {})
    if not isinstance(env, dict):
        record("WARN", "settings.json 'env' is not an object — skipping")
        return

    planned = []
    for key, default in ENV_DEFAULTS.items():
        current = env.get(key)
        if current not in (None, "", CP1_TOKEN_PLACEHOLDER):
            record("SKIP", f"env {key} already set — left untouched")
            continue
        if current == default:
            record("SKIP", f"env {key} already {default!r}")
            continue
        planned.append((key, default))
    for key in ENV_REMOVE:
        if key in env:
            planned.append((key, None))  # None = delete

    if not planned:
        record("SKIP", "settings.json env already up to date")
        return

    if dry:
        for key, val in planned:
            if val is None:
                record("PLAN", f"remove env {key} (retired cp8)")
            elif val == CP1_TOKEN_PLACEHOLDER:
                record("PLAN", f"add env {key} = placeholder (fill in manually)")
            else:
                record("PLAN", f"add env {key} = {val!r}")
        return

    # backup before writing
    if os.path.isfile(SETTINGS):
        bak = SETTINGS + ".bak"
        with open(SETTINGS, "r", encoding="utf-8") as f:
            raw = f.read()
        with open(bak, "w", encoding="utf-8") as f:
            f.write(raw)
        record("DONE", f"backed up settings → {bak}")

    for key, val in planned:
        if val is None:
            env.pop(key, None)
            record("DONE", f"removed env {key}")
        else:
            env[key] = val
            label = "placeholder" if val == CP1_TOKEN_PLACEHOLDER else repr(val)
            record("DONE", f"set env {key} = {label}")
    data["env"] = env
    os.makedirs(os.path.dirname(SETTINGS), exist_ok=True)
    with open(SETTINGS, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def _resolve_invocation_rules_root(project_root):
    """Return the path CLAUDE.md/AGENTS.md discovery should point at.

    Defaults to CLAUDE.md. Redirects to AGENTS.md only when CLAUDE.md exists
    and its entire (comment-stripped, blank-line-stripped) content is exactly
    a single `@AGENTS.md` stub line.
    """
    claude_md_path = os.path.join(project_root, "CLAUDE.md")
    if not os.path.isfile(claude_md_path):
        return claude_md_path
    with open(claude_md_path, "r", encoding="utf-8") as f:
        content = f.read()
    stripped = re.sub(r"<!--.*?-->", "", content, flags=re.S)
    non_blank_lines = [ln.strip() for ln in stripped.splitlines() if ln.strip()]
    if len(non_blank_lines) == 1 and non_blank_lines[0] == "@AGENTS.md":
        return os.path.join(project_root, "AGENTS.md")
    return claude_md_path


def _discover_skill_rows(skills_root):
    """Return `[(name, description), ...]` for installed, user-invocable,
    CipherPol-namespaced skills under `skills_root`, sorted by name.

    `skills_root` is expected to point at a *built* plugin's flat `skills/`
    directory (e.g. `$CLAUDE_PLUGIN_ROOT/skills`), where every persona's
    skills are siblings — see the build-vs-source layout note in this
    skill's docs. Malformed or non-matching SKILL.md files are skipped
    silently; this function only reports what it can confidently use.
    """
    if not skills_root or not os.path.isdir(skills_root):
        return []
    rows = []
    for skill_md in glob.glob(os.path.join(skills_root, "*", "SKILL.md")):
        try:
            with open(skill_md, "r", encoding="utf-8") as f:
                text = f.read()
        except OSError:
            continue
        if not text.startswith("---"):
            continue
        parts = text.split("---")
        if len(parts) < 2:
            continue
        fm = parts[1]
        name_match = re.search(r"^name:\s*(.+)$", fm, re.M)
        desc_match = re.search(r"^description:\s*(.+)$", fm, re.M)
        invocable_match = re.search(r"^user-invocable:\s*(.+)$", fm, re.M)
        if not name_match or not desc_match:
            continue
        if not invocable_match or invocable_match.group(1).strip() != "true":
            continue
        name = name_match.group(1).strip()
        if not SKILL_NAME_RE.match(name):
            continue
        description = desc_match.group(1).strip().replace("|", "\\|")
        rows.append((name, description))
    rows.sort(key=lambda row: row[0])
    return rows


def _render_skills_table_markdown(rows):
    lines = [SKILLS_TABLE_HEADER]
    for name, description in rows:
        lines.append(f"| {description} | `/{name}` |")
    return "\n".join(lines)


def _find_existing_skills_table(content):
    """Locate a usable 2-column "## Skills"-style table in `content`.

    Scans forward from a "Skills" heading through any explanatory prose
    (real-world headings are rarely followed immediately by the table —
    e.g. "## Skills\n\nLocal skills by topic...\n\n| ... |") until it finds
    the first line that looks like a table header immediately followed by
    a valid separator row. Gives up (returns `None`) if it reaches a next
    heading of the same or shallower level first, or if no table appears
    at all, or if the table it finds isn't clearly 2 columns (deliberately
    conservative — falls back rather than guessing).

    Otherwise returns a dict with the line-index span of the table's
    data-row block (`row_start`/`row_end`, exclusive end) and the existing
    data-row lines, so a caller can splice in a replacement row block
    while leaving the heading/prose/header/separator and everything else
    in the file untouched.
    """
    lines = content.splitlines(keepends=True)
    heading_re = re.compile(r"^(#{2,3})\s*Skills?\s*$", re.I)
    heading_idx = None
    heading_level = None
    for i, line in enumerate(lines):
        m = heading_re.match(line.strip())
        if m:
            heading_idx = i
            heading_level = len(m.group(1))
            break
    if heading_idx is None:
        return None

    n = len(lines)
    any_heading_re = re.compile(r"^(#{1,6})\s")
    sep_re = re.compile(r"^\|[\s:|-]+\|$")

    header_idx = None
    i = heading_idx + 1
    while i < n:
        stripped = lines[i].strip()
        hm = any_heading_re.match(stripped)
        if hm and len(hm.group(1)) <= heading_level:
            return None  # left the section without finding a table
        if stripped.startswith("|") and stripped.count("|") >= 2 and i + 1 < n:
            if sep_re.match(lines[i + 1].strip()):
                header_idx = i
                break
        i += 1
    if header_idx is None:
        return None

    header_line = lines[header_idx]
    header_stripped = header_line.strip()
    cells = [c.strip() for c in header_stripped.split("|")]
    if cells and cells[0] == "":
        cells = cells[1:]
    if cells and cells[-1] == "":
        cells = cells[:-1]
    if len(cells) != 2:
        return None

    row_start = header_idx + 2
    j = row_start
    while j < n and lines[j].lstrip().startswith("|"):
        j += 1

    return {
        "row_start": row_start,
        "row_end": j,
        "header_line": header_line,
        "rows": [ln.rstrip("\n") for ln in lines[row_start:j]],
    }


def _merge_skill_rows(existing_row_lines, rows):
    """Drop prior CipherPol-authored rows from `existing_row_lines`, then
    append fresh rows for `rows` — kept foreign rows first, unreordered.
    """
    cipherpol_ref_re = re.compile(r"`/(?:aegis|developer|qa)-[a-z0-9-]+`")
    kept = [line for line in existing_row_lines if not cipherpol_ref_re.search(line)]
    fresh = [f"| {description} | `/{name}` |" for name, description in rows]
    return kept + fresh


def ensure_invocation_rules(dry, template_path, skills_root=None):
    if not template_path:
        return
    if not os.path.isfile(template_path):
        record("WARN", f"invocation-rules template not found: {template_path}")
        return
    try:
        with open(template_path, "r", encoding="utf-8") as f:
            template = f.read()
    except OSError:
        record("WARN", f"invocation-rules template not found: {template_path}")
        return

    rows = _discover_skill_rows(skills_root)

    project_root = os.getcwd()
    root_path = _resolve_invocation_rules_root(project_root)

    root_content = ""
    if os.path.isfile(root_path):
        with open(root_path, "r", encoding="utf-8") as f:
            root_content = f.read()

    assimilate_rel_path = None
    own_pointer_present = False
    for match in re.finditer(r"^@(\.claude/\S+\.md)\s*$", root_content, flags=re.MULTILINE):
        captured = match.group(1)
        if captured == OWN_REL:
            own_pointer_present = True
        elif assimilate_rel_path is None:
            assimilate_rel_path = captured

    target_path = os.path.join(
        project_root, assimilate_rel_path if assimilate_rel_path else OWN_REL
    )

    current_target_content = None
    if os.path.isfile(target_path):
        with open(target_path, "r", encoding="utf-8") as f:
            current_target_content = f.read()

    table_info = _find_existing_skills_table(current_target_content or "")

    if table_info is not None:
        # A usable Skills table already lives in the target file — merge
        # rows into it rather than writing a separate cipherpol-only block.
        new_row_lines = _merge_skill_rows(table_info["rows"], rows)
        lines = (current_target_content or "").splitlines(keepends=True)
        rows_block = "\n".join(new_row_lines)
        if new_row_lines:
            rows_block += "\n"
        spliced = (
            lines[: table_info["row_start"]] + [rows_block] + lines[table_info["row_end"] :]
        )
        desired = "".join(spliced)
        # Self-healing: a prior run (e.g. before this table was found — a
        # heading-followed-by-prose shape used to defeat detection) may have
        # left our own wrapped fallback block elsewhere in this same file.
        # Now that we're merging into the real table, that block is stale
        # and orphaned — remove it rather than maintaining two locations.
        if BEGIN_MARKER in desired and END_MARKER in desired:
            desired = re.sub(
                r"\n*" + re.escape(BEGIN_MARKER) + r".*?" + re.escape(END_MARKER) + r"\n*",
                "\n",
                desired,
                flags=re.S,
            )
    elif assimilate_rel_path:
        rendered = template.replace(
            SKILLS_TABLE_PLACEHOLDER, _render_skills_table_markdown(rows)
        )
        block = BEGIN_MARKER + "\n" + rendered.rstrip() + "\n" + END_MARKER
        if (
            current_target_content is not None
            and BEGIN_MARKER in current_target_content
            and END_MARKER in current_target_content
        ):
            desired = re.sub(
                re.escape(BEGIN_MARKER) + r".*?" + re.escape(END_MARKER),
                block,
                current_target_content,
                flags=re.S,
            )
        else:
            existing = current_target_content or ""
            if existing:
                existing = existing.rstrip("\n") + "\n"
            desired = existing + "\n" + block + "\n"
    else:
        rendered = template.replace(
            SKILLS_TABLE_PLACEHOLDER, _render_skills_table_markdown(rows)
        )
        desired = rendered

    rel_target = os.path.relpath(target_path, project_root)

    if current_target_content == desired:
        record("SKIP", f"invocation-rules already up to date: {rel_target}")
    else:
        if dry:
            record("PLAN", f"write invocation-rules → {rel_target}")
        else:
            os.makedirs(os.path.dirname(target_path), exist_ok=True)
            with open(target_path, "w", encoding="utf-8") as f:
                f.write(desired)
            record("DONE", f"wrote invocation-rules → {rel_target}")

    if table_info is None and assimilate_rel_path is None and not own_pointer_present:
        rel_root = os.path.relpath(root_path, project_root)
        if dry:
            record("PLAN", f"add invocation-rules pointer to {rel_root}")
        else:
            if not os.path.isfile(root_path):
                with open(root_path, "w", encoding="utf-8") as f:
                    f.write("@" + OWN_REL + "\n")
            else:
                with open(root_path, "r", encoding="utf-8") as f:
                    existing_root = f.read()
                if existing_root == "" or existing_root.endswith("\n\n"):
                    new_root = existing_root + "@" + OWN_REL + "\n"
                elif existing_root.endswith("\n"):
                    new_root = existing_root + "\n" + "@" + OWN_REL + "\n"
                else:
                    new_root = existing_root + "\n\n" + "@" + OWN_REL + "\n"
                with open(root_path, "w", encoding="utf-8") as f:
                    f.write(new_root)
            record("DONE", f"added invocation-rules pointer to {rel_root}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="preview actions without changing anything")
    ap.add_argument("--invocation-rules-template", default=None,
                    help="path to the invocation-rules template; omit to skip this step")
    ap.add_argument("--skills-root", default=None,
                    help="path to a built plugin's flat skills/ dir, used to generate "
                         "the invocation-rules Skills table; omit to render an empty table")
    ap.add_argument("--workspace-root", action="append", default=[],
                    help="directory holding repo clones side by side; repeatable. "
                         "Omit to infer the parent of the enclosing git repo")
    args = ap.parse_args()
    dry = args.dry_run

    mode = "DRY-RUN — no changes made" if dry else "APPLYING changes"
    print(f"# CipherPol file setup — {mode}\n")
    ensure_agentic_state(dry)
    ensure_workspace_manifest(dry, args.workspace_root)
    ensure_gitignore(dry)
    ensure_settings_env(dry)
    ensure_invocation_rules(dry, args.invocation_rules_template, args.skills_root)

    warns = sum(1 for s, _ in actions if s == "WARN")
    print(f"\n# Summary: {len(actions)} actions, {warns} warning(s)")
    if not dry and env_needs_token():
        print(
            "\nMANUAL: set CP1_AUTH_TOKEN in ~/.claude/settings.json → env "
            "(ask an admin for the current token), then restart Claude Code."
        )
    return 0


def env_needs_token():
    try:
        with open(SETTINGS, "r", encoding="utf-8") as f:
            env = json.load(f).get("env", {})
    except (OSError, json.JSONDecodeError):
        return False
    return env.get("CP1_AUTH_TOKEN") in (None, "", CP1_TOKEN_PLACEHOLDER)


if __name__ == "__main__":
    sys.exit(main())
