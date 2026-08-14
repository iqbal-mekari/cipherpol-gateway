#!/usr/bin/env python3
"""Resolve the Working Context for an aegis run.

Walks the resolution ladder (see SKILL.md) and prints `key=value` lines on
stdout. Rungs 1-5 resolve silently; when several repos remain plausible the
script prints `source=ambiguous` plus one `candidate=` line per repo and lets
the calling orchestrator run AskUserQuestion — a skill cannot prompt from
inside an agent, so the choice is yielded upward rather than attempted here.

Never raises on bad input: an unreadable manifest or missing taxonomy degrades
to fewer resolved fields, never a traceback. Callers treat a missing
`project_root` as "ask", not as failure.
"""

import argparse
import glob
import json
import os
import subprocess
import sys

HOME = os.path.expanduser("~")
# CIPHERPOL_WORKSPACE_MANIFEST relocates the manifest — used by the tests, and by
# anyone keeping the file outside ~/.claude.
MANIFEST = os.environ.get(
    "CIPHERPOL_WORKSPACE_MANIFEST",
    os.path.join(HOME, ".claude", "cipherpol-workspace.json"),
)


def _load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}


def _expand(p):
    return os.path.abspath(os.path.expanduser(p))


def detect_platform(root, taxonomy):
    """Return the search_docs `platform` facet of the first matching platform."""
    for plat in taxonomy.get("platforms", []):
        for marker in plat.get("detection_markers", []):
            if glob.glob(os.path.join(root, marker)):
                return plat.get("cp1_platform", plat["id"])
    return ""


def project_ids(taxonomy):
    return {p["id"]: p for p in taxonomy.get("projects", [])}


def describe(root, taxonomy):
    """Build a candidate record for a repo path, or None if it isn't one."""
    if not os.path.isdir(root):
        return None
    platform = detect_platform(root, taxonomy)
    if not platform:
        return None
    name = os.path.basename(root)
    known = project_ids(taxonomy).get(name, {})
    return {
        "path": root,
        "project": known.get("id", name),
        "platform": platform,
        "cp1_slug": known.get("cp1_slug", ""),
    }


def git_toplevel(start):
    try:
        out = subprocess.run(
            ["git", "-C", start, "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=5,
        )
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def manifest_repos(manifest, taxonomy):
    """Explicit manifest entries first, then autodiscovery under workspace_roots."""
    found, seen = [], set()

    for entry in manifest.get("repos", []):
        path = _expand(entry.get("path", ""))
        if not os.path.isdir(path) or path in seen:
            continue  # stale entry — cache, not contract; skip silently
        seen.add(path)
        rec = describe(path, taxonomy) or {"path": path, "project": os.path.basename(path)}
        # Manifest values win over sniffed ones.
        for k in ("project", "platform", "cp1_slug"):
            if entry.get(k):
                rec[k] = entry[k]
        found.append(rec)

    for root in manifest.get("workspace_roots", []):
        root = _expand(root)
        if not os.path.isdir(root):
            continue
        for child in sorted(os.listdir(root)):
            path = os.path.join(root, child)
            if path in seen:
                continue
            rec = describe(path, taxonomy)
            if rec:
                seen.add(path)
                found.append(rec)

    return found


def emit(rec, source, taxonomy):
    slug = rec.get("cp1_slug", "")
    if not slug:
        slug = project_ids(taxonomy).get(rec.get("project", ""), {}).get("cp1_slug", "")
    lines = [
        f"project_root={rec['path']}",
        f"platform={rec.get('platform', '')}",
        f"project={rec.get('project', '')}",
        f"cp1_slug={slug}",
        f"state_dir={os.path.join(rec['path'], '.claude', 'agentic-state')}",
        f"source={source}",
    ]
    print("\n".join(lines))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="", help="explicit project id or path (rung 1)")
    ap.add_argument("--hint", default="", help="user message text to scan for a project id (rung 3)")
    ap.add_argument("--path", action="append", default=[], help="argument path implying a repo (rung 4)")
    ap.add_argument("--platform", default="", help="restrict manifest matches to this platform (rung 5)")
    ap.add_argument("--taxonomy", default="", help="path to cipherpol.json")
    args = ap.parse_args()

    taxonomy = _load_json(args.taxonomy) if args.taxonomy else {}
    manifest = _load_json(MANIFEST)
    repos = manifest_repos(manifest, taxonomy)
    by_project = {r["project"]: r for r in repos}

    # Env override — pre-ladder. Only usable when it also gives us a location.
    env_root = os.environ.get("CIPHERPOL_PROJECT_ROOT", "")
    if env_root and os.path.isdir(_expand(env_root)):
        root = _expand(env_root)
        rec = describe(root, taxonomy) or {"path": root, "project": os.path.basename(root)}
        for k, ev in (("platform", "CIPHERPOL_PLATFORM"),
                      ("project", "CIPHERPOL_PROJECT"),
                      ("cp1_slug", "CIPHERPOL_CP1_SLUG")):
            if os.environ.get(ev):
                rec[k] = os.environ[ev]
        emit(rec, "env", taxonomy)
        return

    # Rung 1 — explicit --repo, as an id or a path.
    if args.repo:
        if args.repo in by_project:
            emit(by_project[args.repo], "explicit", taxonomy)
            return
        root = _expand(args.repo)
        rec = describe(root, taxonomy)
        if rec:
            emit(rec, "explicit", taxonomy)
            return
        print(f"error=unknown repo '{args.repo}'")
        sys.exit(2)

    # Rung 2 — CWD inside a repo carrying a platform marker. Today's behavior.
    top = git_toplevel(os.getcwd())
    if top:
        rec = describe(top, taxonomy)
        if rec:
            # Env identity still refines a CWD-resolved location.
            for k, ev in (("platform", "CIPHERPOL_PLATFORM"),
                          ("project", "CIPHERPOL_PROJECT"),
                          ("cp1_slug", "CIPHERPOL_CP1_SLUG")):
                if os.environ.get(ev):
                    rec[k] = os.environ[ev]
            emit(rec, "cwd", taxonomy)
            return

    # Rung 3 — a known project id named in the user message.
    if args.hint:
        low = args.hint.lower()
        named = [r for pid, r in by_project.items() if pid.lower() in low]
        if len(named) == 1:
            emit(named[0], "message", taxonomy)
            return

    # Rung 4 — an argument path lands inside exactly one known repo.
    if args.path:
        implied = []
        for raw in args.path:
            p = _expand(raw)
            for r in repos:
                if (p == r["path"] or p.startswith(r["path"] + os.sep)) and r not in implied:
                    implied.append(r)
        if len(implied) == 1:
            emit(implied[0], "inputs", taxonomy)
            return

    # Rung 5 — exactly one manifest repo matches the required platform.
    pool = [r for r in repos if r.get("platform") == args.platform] if args.platform else repos
    if len(pool) == 1:
        emit(pool[0], "manifest", taxonomy)
        return

    # Rung 6 — yield the choice to the caller.
    print("source=ambiguous")
    for r in pool:
        print(f"candidate={r['project']}\t{r.get('platform', '')}\t{r['path']}")
    if not pool:
        print("error=no candidate repos — add workspace_roots to ~/.claude/cipherpol-workspace.json")


if __name__ == "__main__":
    main()
