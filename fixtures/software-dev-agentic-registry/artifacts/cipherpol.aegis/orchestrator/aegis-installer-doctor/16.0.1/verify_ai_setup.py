#!/usr/bin/env python3
"""Read-only verification of a project's committed Claude Code AI baseline.

All expectations come from a per-repo JSON manifest (default:
.claude/ai-baseline.json). Every manifest section is optional — checks for
absent sections are skipped. Run from the repo root.

Usage:
    python3 verify_ai_setup.py [--manifest PATH] [--environment]

Exit codes: 0 = all checks pass · 1 = one or more errors · 2 = usage error.
"""

import json
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path.cwd()
DEFAULT_MANIFEST = ".claude/ai-baseline.json"
PERSONAL_PATH = re.compile(r"/(?:Users|home)/[^/\s]+/")
CREDENTIAL_KEY_PARTS = (
    "header",
    "token",
    "secret",
    "authorization",
    "apikey",
    "password",
    "cookie",
    "credential",
)


def display_path(path):
    try:
        return path.relative_to(ROOT)
    except ValueError:
        return path


def read_json(path, errors):
    try:
        with path.open(encoding="utf-8") as handle:
            value = json.load(handle)
    except FileNotFoundError:
        errors.append("{} is missing".format(display_path(path)))
        return None
    except json.JSONDecodeError as exc:
        errors.append(
            "{} is invalid JSON at line {}, column {}: {}".format(
                display_path(path), exc.lineno, exc.colno, exc.msg
            )
        )
        return None
    except (OSError, UnicodeError) as exc:
        errors.append("cannot read {}: {}".format(display_path(path), exc))
        return None

    if not isinstance(value, dict):
        errors.append("{} must contain a JSON object".format(display_path(path)))
        return None
    return value


def forbidden_keys(value, path=""):
    if isinstance(value, dict):
        for key, child in value.items():
            key_path = "{}.{}".format(path, key) if path else str(key)
            normalized = re.sub(r"[^a-z0-9]", "", str(key).lower())
            if normalized != "env" and any(
                part in normalized for part in CREDENTIAL_KEY_PARTS
            ):
                yield key_path
            yield from forbidden_keys(child, key_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from forbidden_keys(child, "{}[{}]".format(path, index))


def verify_settings(manifest, settings_path, errors):
    keys = (
        "marketplace",
        "enabled_plugins",
        "env",
        "skill_listing_budget_fraction",
        "enabled_mcpjson_servers",
    )
    if not any(key in manifest for key in keys):
        return
    settings = read_json(settings_path, errors)
    if settings is None:
        return
    display = display_path(settings_path)

    marketplace = manifest.get("marketplace")
    if isinstance(marketplace, dict):
        key = marketplace.get("key", "")
        expected_source = marketplace.get("source")
        marketplaces = settings.get("extraKnownMarketplaces")
        entry = marketplaces.get(key) if isinstance(marketplaces, dict) else None
        source = entry.get("source") if isinstance(entry, dict) else None
        if source != expected_source:
            errors.append(
                "{} marketplace {!r} source must equal {}".format(
                    display, key, json.dumps(expected_source, sort_keys=True)
                )
            )

    if "enabled_plugins" in manifest:
        if settings.get("enabledPlugins") != manifest["enabled_plugins"]:
            errors.append(
                "{} enabledPlugins must equal {}".format(
                    display, json.dumps(manifest["enabled_plugins"], sort_keys=True)
                )
            )

    if "env" in manifest:
        if settings.get("env") != manifest["env"]:
            errors.append(
                "{} env must equal {}".format(
                    display, json.dumps(manifest["env"], sort_keys=True)
                )
            )

    if "skill_listing_budget_fraction" in manifest:
        expected = manifest["skill_listing_budget_fraction"]
        if settings.get("skillListingBudgetFraction") != expected:
            errors.append(
                "{} skillListingBudgetFraction must equal {}".format(display, expected)
            )

    if "enabled_mcpjson_servers" in manifest:
        if settings.get("enableAllProjectMcpServers") is not False:
            errors.append(
                "{} enableAllProjectMcpServers must be false".format(display)
            )
        if settings.get("enabledMcpjsonServers") != manifest["enabled_mcpjson_servers"]:
            errors.append(
                "{} enabledMcpjsonServers must equal {}".format(
                    display, json.dumps(manifest["enabled_mcpjson_servers"])
                )
            )


def verify_mcp(manifest, mcp_path, errors):
    if "mcp_servers" not in manifest:
        return
    mcp_config = read_json(mcp_path, errors)
    if mcp_config is None:
        return
    display = display_path(mcp_path)

    servers = mcp_config.get("mcpServers")
    if not isinstance(servers, dict):
        errors.append("{} mcpServers must be an object".format(display))
    elif servers != manifest["mcp_servers"]:
        errors.append(
            "{} mcpServers must match the approved server definitions exactly".format(
                display
            )
        )
    for key_path in forbidden_keys(mcp_config):
        errors.append(
            "{} contains forbidden credential-like key: {}".format(display, key_path)
        )


def verify_gitignore(manifest, errors):
    required = manifest.get("gitignore_required")
    if not required:
        return
    gitignore_path = ROOT / ".gitignore"
    try:
        lines = gitignore_path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        errors.append(".gitignore is missing")
        return
    except (OSError, UnicodeError) as exc:
        errors.append("cannot read .gitignore: {}".format(exc))
        return
    patterns = {
        line.strip()
        for line in lines
        if line.strip() and not line.lstrip().startswith("#")
    }
    for pattern in required:
        if pattern not in patterns:
            errors.append(".gitignore must contain {}".format(pattern))


def verify_claude_md(manifest, errors):
    required = manifest.get("claude_md_required_lines")
    if not required:
        return
    claude_path = ROOT / "CLAUDE.md"
    try:
        content = claude_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        errors.append("CLAUDE.md is missing")
        return
    except (OSError, UnicodeError) as exc:
        errors.append("cannot read CLAUDE.md: {}".format(exc))
        return
    for line in required:
        if line not in content:
            errors.append("CLAUDE.md must contain {!r}".format(line))


def scan_target_paths(scan_paths, errors):
    """Resolve scan_paths to concrete files: git-tracked files under each
    directory, plus files listed explicitly (scanned even if untracked)."""
    paths = set()
    directories = []
    for entry in scan_paths:
        candidate = ROOT / entry
        if candidate.is_dir():
            directories.append(entry)
        else:
            paths.add(candidate)
    if directories:
        try:
            result = subprocess.run(
                ["git", "-C", str(ROOT), "ls-files", "-z", "--", *directories],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
        except OSError as exc:
            errors.append("cannot list committed files with git: {}".format(exc))
            return sorted(paths)
        if result.returncode != 0:
            detail = result.stderr.decode("utf-8", errors="replace").strip()
            errors.append("cannot list committed files with git: {}".format(detail))
            return sorted(paths)
        encoding = sys.getfilesystemencoding()
        for raw_path in result.stdout.split(b"\0"):
            if raw_path:
                relative = raw_path.decode(encoding, errors="surrogateescape")
                paths.add(ROOT / relative)
    return sorted(paths)


def scan_stale_references(manifest, manifest_path, errors):
    scan_paths = manifest.get("scan_paths")
    if not scan_paths:
        return
    patterns = [
        (text, re.compile(re.escape(text), re.IGNORECASE))
        for text in manifest.get("stale_references", [])
    ]
    for path in scan_target_paths(scan_paths, errors):
        if path == manifest_path:
            continue  # the manifest legitimately names the stale strings
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except FileNotFoundError:
            errors.append("{} is missing".format(display_path(path)))
            continue
        except (OSError, UnicodeError) as exc:
            errors.append("cannot scan {}: {}".format(display_path(path), exc))
            continue

        for number, line in enumerate(lines, start=1):
            matches = [text for text, pattern in patterns if pattern.search(line)]
            personal_path = PERSONAL_PATH.search(line)
            if personal_path:
                matches.append(personal_path.group(0))
            for match in matches:
                errors.append(
                    "stale reference {!r} in {}:{}".format(
                        match, display_path(path), number
                    )
                )


def run_claude_command(arguments, errors):
    try:
        result = subprocess.run(
            ["claude", *arguments],
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
            timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        errors.append("cannot run claude {}: {}".format(" ".join(arguments), exc))
        return ""
    if result.returncode != 0:
        errors.append(
            "claude {} failed: {}".format(" ".join(arguments), result.stdout.strip())
        )
    return result.stdout


def verify_environment(manifest, errors):
    forbidden = manifest.get("forbidden_marketplaces", [])
    if forbidden:
        marketplace_output = run_claude_command(
            ["plugin", "marketplace", "list"], errors
        )
        for legacy_source in forbidden:
            if legacy_source in marketplace_output:
                errors.append(
                    "forbidden marketplace detected in Claude environment: {}".format(
                        legacy_source
                    )
                )

    required_plugins = manifest.get("required_installed_plugins", [])
    if required_plugins:
        plugin_output = run_claude_command(["plugin", "list"], errors)
        for plugin in required_plugins:
            if not re.search(
                r"(?m){}(?:\s|$)".format(re.escape(plugin)), plugin_output
            ):
                errors.append("required installed plugin is missing: {}".format(plugin))
            if "@" not in plugin:
                continue
            name, expected_marketplace = plugin.rsplit("@", 1)
            installed = re.findall(
                r"{}@([A-Za-z0-9._-]+)".format(re.escape(name)), plugin_output
            )
            duplicates = sorted(
                {
                    marketplace
                    for marketplace in installed
                    if marketplace != expected_marketplace
                }
            )
            for marketplace in duplicates:
                errors.append(
                    "duplicate plugin {} is also installed from marketplace: {}".format(
                        name, marketplace
                    )
                )

    expected_mcp = manifest.get("expected_connected_mcp", [])
    if expected_mcp:
        mcp_output = run_claude_command(["mcp", "list"], errors)
        for server in expected_mcp:
            matching_lines = [
                line.strip()
                for line in mcp_output.splitlines()
                if line.strip().startswith("{}:".format(server))
            ]
            if not matching_lines or not any(
                "Connected" in line for line in matching_lines
            ):
                errors.append("MCP server is not connected: {}".format(server))


def main():
    manifest_arg = DEFAULT_MANIFEST
    verify_runtime = False
    arguments = sys.argv[1:]
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if argument == "--environment":
            verify_runtime = True
        elif argument == "--manifest":
            index += 1
            if index >= len(arguments):
                print("Usage: verify_ai_setup.py [--manifest PATH] [--environment]")
                return 2
            manifest_arg = arguments[index]
        elif argument.startswith("--manifest="):
            manifest_arg = argument.split("=", 1)[1]
        else:
            print("Usage: verify_ai_setup.py [--manifest PATH] [--environment]")
            return 2
        index += 1

    manifest_path = ROOT / manifest_arg
    if not manifest_path.is_file():
        print(
            "ERROR: manifest {} not found — create it or pass --manifest PATH".format(
                display_path(manifest_path)
            )
        )
        return 1
    errors = []
    manifest = read_json(manifest_path, errors)
    if manifest is None:
        for error in errors:
            print("ERROR: {}".format(error))
        return 1

    settings_path = ROOT / manifest.get("settings_path", ".claude/settings.json")
    mcp_path = ROOT / manifest.get("mcp_path", ".mcp.json")

    verify_settings(manifest, settings_path, errors)
    verify_mcp(manifest, mcp_path, errors)
    verify_gitignore(manifest, errors)
    verify_claude_md(manifest, errors)
    scan_stale_references(manifest, manifest_path, errors)
    if verify_runtime:
        verify_environment(manifest, errors)

    if errors:
        for error in errors:
            print("ERROR: {}".format(error))
        return 1

    print("PASS: manifest and JSON configuration parse")
    if any(
        key in manifest
        for key in (
            "marketplace",
            "enabled_plugins",
            "env",
            "skill_listing_budget_fraction",
            "enabled_mcpjson_servers",
        )
    ):
        print(
            "PASS: {} matches the manifest baseline".format(
                display_path(settings_path)
            )
        )
    if "mcp_servers" in manifest:
        print(
            "PASS: {} matches approved servers and contains no credential-like keys".format(
                display_path(mcp_path)
            )
        )
    if manifest.get("gitignore_required"):
        print("PASS: required .gitignore patterns present")
    if manifest.get("claude_md_required_lines"):
        print("PASS: CLAUDE.md contains the required baseline lines")
    if manifest.get("scan_paths"):
        print("PASS: scanned files contain no stale references or personal paths")
    if verify_runtime:
        print("PASS: installed plugins, marketplaces, and MCP servers are aligned")
    return 0


if __name__ == "__main__":
    sys.exit(main())
