#!/usr/bin/env python3
"""Tests for ensure_invocation_rules() in setup_cipherpol.py.

Dependency-free stdlib unittest only (Python 3.9+), matching the module under
test. Run with:

    cd cipherpol-aegis/lib/aegis/skills/orchestrators/aegis-setup-cipherpol
    python3 -m unittest test_setup_cipherpol.py

or from anywhere via:

    python3 -m unittest discover -s cipherpol-aegis/lib/aegis/skills/orchestrators/aegis-setup-cipherpol
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import setup_cipherpol  # noqa: E402


TEMPLATE = (
    "<!-- cipherpol-invocation-rules v2 -->\n"
    "# CipherPol — Invocation Rules\n"
    "\n"
    "Some quick-start pointers live here.\n"
    "\n"
    "## Skills\n"
    "\n"
    "<!-- CIPHERPOL_SKILLS_TABLE -->\n"
    "\n"
    "## Keeping this in sync\n"
    "\n"
    "Regenerated on every rerun.\n"
)

OWN_REL = setup_cipherpol.OWN_REL  # ".claude/cipherpol-invocation-rules.md"


def _skill_frontmatter(name, description, user_invocable="true"):
    lines = ["---", f"name: {name}"]
    if description is not None:
        lines.append(f"description: {description}")
    if user_invocable is not None:
        lines.append(f"user-invocable: {user_invocable}")
    lines += ["allowed-tools: Bash", "---", "", f"Body for {name}.", ""]
    return "\n".join(lines)


class InvocationRulesTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.project_root = self._tmpdir.name

        self._orig_cwd = os.getcwd()
        os.chdir(self.project_root)
        self.addCleanup(os.chdir, self._orig_cwd)

        # fixed template fixture, written outside the project root
        self._template_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._template_dir.cleanup)
        self.template_path = os.path.join(self._template_dir.name, "invocation-rules.md")
        self._write_template(TEMPLATE)

        # fixture skills root, written outside the project root
        self._skills_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._skills_dir.cleanup)
        self.skills_root = self._skills_dir.name

        setup_cipherpol.actions.clear()
        self.addCleanup(setup_cipherpol.actions.clear)

    def _write_template(self, content):
        with open(self.template_path, "w", encoding="utf-8") as f:
            f.write(content)

    def _write_skill(self, name, description, user_invocable="true"):
        skill_dir = os.path.join(self.skills_root, name)
        os.makedirs(skill_dir, exist_ok=True)
        with open(os.path.join(skill_dir, "SKILL.md"), "w", encoding="utf-8") as f:
            f.write(_skill_frontmatter(name, description, user_invocable))

    def _remove_skill(self, name):
        shutil.rmtree(os.path.join(self.skills_root, name), ignore_errors=True)

    def _default_skill_fixtures(self):
        self._write_skill("aegis-fake-one", "Do the first fake thing")
        self._write_skill("developer-fake-two", "Do the second fake thing")
        self._write_skill("qa-fake-hidden", "Should not appear", user_invocable="false")
        self._write_skill("cp1-fake", "Out of scope prefix")

    def _write(self, rel_path, content):
        full = os.path.join(self.project_root, rel_path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as f:
            f.write(content)

    def _read(self, rel_path):
        with open(os.path.join(self.project_root, rel_path), "r", encoding="utf-8") as f:
            return f.read()

    def _exists(self, rel_path):
        return os.path.isfile(os.path.join(self.project_root, rel_path))

    def _statuses(self):
        return [status for status, _ in setup_cipherpol.actions]

    def _run(self, dry=False, skills_root=None):
        setup_cipherpol.ensure_invocation_rules(dry, self.template_path, skills_root)

    # 1. Fresh install — no CLAUDE.md exists.
    def test_fresh_install_creates_own_file_and_pointer(self):
        self._default_skill_fixtures()

        self._run(skills_root=self.skills_root)

        self.assertTrue(self._exists(OWN_REL))
        own_content = self._read(OWN_REL)
        self.assertIn("## Skills", own_content)
        self.assertIn("| Do the first fake thing | `/aegis-fake-one` |", own_content)
        self.assertIn("| Do the second fake thing | `/developer-fake-two` |", own_content)
        self.assertNotIn("qa-fake-hidden", own_content)
        self.assertNotIn("cp1-fake", own_content)
        self.assertNotIn("<!-- CIPHERPOL_SKILLS_TABLE -->", own_content)

        self.assertTrue(self._exists("CLAUDE.md"))
        claude_md_lines = [ln.strip() for ln in self._read("CLAUDE.md").splitlines()]
        self.assertIn("@" + OWN_REL, claude_md_lines)

    # 2. Append to existing CLAUDE.md with unrelated prior content.
    def test_append_pointer_to_existing_claude_md(self):
        self._default_skill_fixtures()
        prior = "# My Project\n\nSome existing instructions.\n"
        self._write("CLAUDE.md", prior)

        self._run(skills_root=self.skills_root)

        new_content = self._read("CLAUDE.md")
        self.assertIn("Some existing instructions.", new_content)
        claude_md_lines = [ln.strip() for ln in new_content.splitlines()]
        self.assertIn("@" + OWN_REL, claude_md_lines)

        self.assertTrue(self._exists(OWN_REL))
        own_content = self._read(OWN_REL)
        self.assertIn("| Do the first fake thing | `/aegis-fake-one` |", own_content)

    # 3. Assimilate into an existing foreign pointer (no table in the foreign file).
    def test_assimilate_into_foreign_pointer(self):
        self._default_skill_fixtures()
        foreign_rel = ".claude/other-tool-rules.md"
        self._write("CLAUDE.md", "@" + foreign_rel + "\n")
        foreign_prior = "# Other Tool Rules\n\nDo not touch this.\n"
        self._write(foreign_rel, foreign_prior)
        original_claude_md = self._read("CLAUDE.md")

        self._run(skills_root=self.skills_root)

        # our own file must not be created
        self.assertFalse(self._exists(OWN_REL))

        foreign_content = self._read(foreign_rel)
        self.assertIn("Do not touch this.", foreign_content)
        self.assertIn("<!-- BEGIN cipherpol-invocation-rules -->", foreign_content)
        self.assertIn("<!-- END cipherpol-invocation-rules -->", foreign_content)
        self.assertIn("| Do the first fake thing | `/aegis-fake-one` |", foreign_content)

        # CLAUDE.md itself is unchanged — the existing pointer already satisfies discovery
        self.assertEqual(self._read("CLAUDE.md"), original_claude_md)

    # 4. Stub redirect to AGENTS.md.
    def test_stub_claude_md_redirects_to_agents_md(self):
        self._default_skill_fixtures()
        self._write("CLAUDE.md", "@AGENTS.md\n")
        original_claude_md = self._read("CLAUDE.md")
        self.assertFalse(self._exists("AGENTS.md"))

        self._run(skills_root=self.skills_root)

        self.assertTrue(self._exists(OWN_REL))
        own_content = self._read(OWN_REL)
        self.assertIn("| Do the first fake thing | `/aegis-fake-one` |", own_content)

        self.assertTrue(self._exists("AGENTS.md"))
        agents_md_lines = [ln.strip() for ln in self._read("AGENTS.md").splitlines()]
        self.assertIn("@" + OWN_REL, agents_md_lines)

        # CLAUDE.md itself must be left completely untouched
        self.assertEqual(self._read("CLAUDE.md"), original_claude_md)

    # 5. Idempotent rerun.
    def test_idempotent_rerun_is_all_skip_and_byte_identical(self):
        self._default_skill_fixtures()
        self._run(skills_root=self.skills_root)
        first_run_bytes = self._read(OWN_REL)
        first_run_claude_md = self._read("CLAUDE.md")

        setup_cipherpol.actions.clear()
        self._run(skills_root=self.skills_root)

        self.assertTrue(all(status == "SKIP" for status in self._statuses()))
        self.assertEqual(self._read(OWN_REL), first_run_bytes)
        self.assertEqual(self._read("CLAUDE.md"), first_run_claude_md)

    # 6. Removing a fixture skill drops its row on rerun (staleness story for
    # the table replaces the old version-marker-mismatch test).
    def test_removed_skill_drops_its_row_on_rerun(self):
        self._write_skill("aegis-fake-one", "Do the first fake thing")
        self._write_skill("developer-fake-two", "Do the second fake thing")

        self._run(skills_root=self.skills_root)
        own_content = self._read(OWN_REL)
        self.assertIn("/aegis-fake-one", own_content)
        self.assertIn("/developer-fake-two", own_content)

        self._remove_skill("developer-fake-two")
        setup_cipherpol.actions.clear()
        self._run(skills_root=self.skills_root)

        own_content = self._read(OWN_REL)
        self.assertIn("/aegis-fake-one", own_content)
        self.assertNotIn("/developer-fake-two", own_content)

    # 7. Merge into a pre-existing foreign Skills table.
    def test_merge_into_existing_foreign_skills_table(self):
        self._write_skill("aegis-fake-one", "Do the first fake thing")
        self._write_skill("developer-fake-two", "Do the second fake thing")

        foreign_rel = ".claude/other-tool-rules.md"
        self._write("CLAUDE.md", "@" + foreign_rel + "\n")
        foreign_prior = (
            "# Other Tool Rules\n"
            "\n"
            "Some prose above the table.\n"
            "\n"
            "## Skills\n"
            "\n"
            "| When the user asks about… | Invoke this skill |\n"
            "|---|---|\n"
            "| Recalling shared project memory | `/memory` |\n"
            "\n"
            "Some prose below the table.\n"
        )
        self._write(foreign_rel, foreign_prior)
        original_claude_md = self._read("CLAUDE.md")

        self._run(skills_root=self.skills_root)

        self.assertFalse(self._exists(OWN_REL))

        foreign_content = self._read(foreign_rel)
        self.assertIn("Some prose above the table.", foreign_content)
        self.assertIn("Some prose below the table.", foreign_content)
        self.assertIn("| Recalling shared project memory | `/memory` |", foreign_content)
        self.assertIn("| Do the first fake thing | `/aegis-fake-one` |", foreign_content)
        self.assertIn("| Do the second fake thing | `/developer-fake-two` |", foreign_content)
        # no wrapper markers or pointer line for the merge path
        self.assertNotIn("<!-- BEGIN cipherpol-invocation-rules -->", foreign_content)
        self.assertEqual(self._read("CLAUDE.md"), original_claude_md)

    # 8. Column-count mismatch falls back correctly (no merge attempted).
    def test_column_count_mismatch_falls_back(self):
        self._write_skill("aegis-fake-one", "Do the first fake thing")

        foreign_rel = ".claude/other-tool-rules.md"
        self._write("CLAUDE.md", "@" + foreign_rel + "\n")
        three_col_table = (
            "# Other Tool Rules\n"
            "\n"
            "## Skills\n"
            "\n"
            "| Name | Description | Notes |\n"
            "|---|---|---|\n"
            "| memory | recall stuff | n/a |\n"
        )
        self._write(foreign_rel, three_col_table)

        self._run(skills_root=self.skills_root)

        foreign_content = self._read(foreign_rel)
        # the 3-column table is left completely untouched
        self.assertIn("| Name | Description | Notes |\n|---|---|---|\n| memory | recall stuff | n/a |", foreign_content)
        # fallback wrapped-block append happened instead
        self.assertIn("<!-- BEGIN cipherpol-invocation-rules -->", foreign_content)
        self.assertIn("| Do the first fake thing | `/aegis-fake-one` |", foreign_content)

    # 9b. Heading followed by explanatory prose before the table (the real
    # shape seen in practice — a bare heading immediately followed by the
    # table, with no prose in between, is the exception, not the rule).
    def test_table_detected_past_intervening_prose(self):
        self._write_skill("aegis-fake-one", "Do the first fake thing")

        foreign_rel = ".claude/other-tool-rules.md"
        self._write("CLAUDE.md", "@" + foreign_rel + "\n")
        foreign_prior = (
            "# Other Tool Rules\n"
            "\n"
            "## Skills\n"
            "\n"
            "Local skills by topic. The trigger is the slash command; invoke via\n"
            "the Skill tool. This is the only registry.\n"
            "\n"
            "| When the user asks about… | Invoke this skill |\n"
            "|---|---|\n"
            "| Recalling shared project memory | `/memory` |\n"
            "\n"
            "## Verification\n"
            "\n"
            "Some unrelated later section.\n"
        )
        self._write(foreign_rel, foreign_prior)

        self._run(skills_root=self.skills_root)

        foreign_content = self._read(foreign_rel)
        self.assertFalse(self._exists(OWN_REL))
        self.assertNotIn("<!-- BEGIN cipherpol-invocation-rules -->", foreign_content)
        self.assertIn("Local skills by topic.", foreign_content)
        self.assertIn("| Recalling shared project memory | `/memory` |", foreign_content)
        self.assertIn("| Do the first fake thing | `/aegis-fake-one` |", foreign_content)
        self.assertIn("Some unrelated later section.", foreign_content)

    # 9c. Self-healing: a leftover wrapped block from a prior run (e.g. one
    # written back when this same table's detection used to fail) gets
    # cleaned up once the real table is found and merged into instead.
    def test_leftover_wrapped_block_is_removed_once_table_is_found(self):
        self._write_skill("aegis-fake-one", "Do the first fake thing")

        foreign_rel = ".claude/other-tool-rules.md"
        self._write("CLAUDE.md", "@" + foreign_rel + "\n")
        foreign_prior = (
            "# Other Tool Rules\n"
            "\n"
            "## Skills\n"
            "\n"
            "| When the user asks about… | Invoke this skill |\n"
            "|---|---|\n"
            "| Recalling shared project memory | `/memory` |\n"
            "\n"
            "<!-- BEGIN cipherpol-invocation-rules -->\n"
            "<!-- cipherpol-invocation-rules v2 -->\n"
            "# CipherPol — Invocation Rules\n"
            "\n"
            "## Skills\n"
            "\n"
            "| When the user asks about… | Invoke this skill |\n"
            "|---|---|\n"
            "| Some stale row | `/developer-stale-fake` |\n"
            "<!-- END cipherpol-invocation-rules -->\n"
        )
        self._write(foreign_rel, foreign_prior)

        self._run(skills_root=self.skills_root)

        foreign_content = self._read(foreign_rel)
        self.assertNotIn("<!-- BEGIN cipherpol-invocation-rules -->", foreign_content)
        self.assertNotIn("<!-- END cipherpol-invocation-rules -->", foreign_content)
        self.assertNotIn("developer-stale-fake", foreign_content)
        self.assertIn("| Recalling shared project memory | `/memory` |", foreign_content)
        self.assertIn("| Do the first fake thing | `/aegis-fake-one` |", foreign_content)
        # exactly one "## Skills" heading remains — no duplicate section
        self.assertEqual(foreign_content.count("## Skills"), 1)

    # 9. Idempotent rerun of a table merge.
    def test_idempotent_rerun_of_table_merge(self):
        self._write_skill("aegis-fake-one", "Do the first fake thing")

        foreign_rel = ".claude/other-tool-rules.md"
        self._write("CLAUDE.md", "@" + foreign_rel + "\n")
        foreign_prior = (
            "# Other Tool Rules\n"
            "\n"
            "## Skills\n"
            "\n"
            "| When the user asks about… | Invoke this skill |\n"
            "|---|---|\n"
            "| Recalling shared project memory | `/memory` |\n"
        )
        self._write(foreign_rel, foreign_prior)

        self._run(skills_root=self.skills_root)
        first_run_content = self._read(foreign_rel)
        first_row_count = first_run_content.count("\n| ")

        setup_cipherpol.actions.clear()
        self._run(skills_root=self.skills_root)

        second_run_content = self._read(foreign_rel)
        self.assertIn("SKIP", self._statuses())
        self.assertEqual(second_run_content, first_run_content)
        self.assertEqual(second_run_content.count("\n| "), first_row_count)


class WorkspaceManifestTestCase(unittest.TestCase):
    """ensure_workspace_manifest() — creation, idempotency, and non-clobbering."""

    def setUp(self):
        self._home = tempfile.TemporaryDirectory()
        self.addCleanup(self._home.cleanup)
        self._orig_home = setup_cipherpol.HOME
        setup_cipherpol.HOME = self._home.name
        self.addCleanup(setattr, setup_cipherpol, "HOME", self._orig_home)
        self.path = os.path.join(self._home.name, ".claude", "cipherpol-workspace.json")
        setup_cipherpol.actions.clear()

    def _read(self):
        with open(self.path, encoding="utf-8") as f:
            return json.load(f)

    def _statuses(self):
        return [s for s, _ in setup_cipherpol.actions]

    def test_creates_with_explicit_root(self):
        setup_cipherpol.ensure_workspace_manifest(False, ["/tmp/ws-a"])
        data = self._read()
        self.assertEqual(data["schema_version"], 1)
        self.assertEqual(data["workspace_roots"], ["/tmp/ws-a"])
        self.assertIn("DONE", self._statuses())

    def test_dry_run_writes_nothing(self):
        setup_cipherpol.ensure_workspace_manifest(True, ["/tmp/ws-a"])
        self.assertFalse(os.path.exists(self.path))
        self.assertIn("PLAN", self._statuses())

    def test_rerun_is_idempotent(self):
        setup_cipherpol.ensure_workspace_manifest(False, ["/tmp/ws-a"])
        first = self._read()
        setup_cipherpol.actions.clear()
        setup_cipherpol.ensure_workspace_manifest(False, ["/tmp/ws-a"])
        self.assertEqual(self._read(), first)
        self.assertIn("SKIP", self._statuses())

    def test_extends_without_dropping_existing_roots(self):
        setup_cipherpol.ensure_workspace_manifest(False, ["/tmp/ws-a"])
        setup_cipherpol.ensure_workspace_manifest(False, ["/tmp/ws-b"])
        self.assertEqual(self._read()["workspace_roots"], ["/tmp/ws-a", "/tmp/ws-b"])

    def test_preserves_resolver_maintained_repo_cache(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        seeded = {
            "schema_version": 1,
            "workspace_roots": ["/tmp/ws-a"],
            "repos": [{"path": "/tmp/ws-a/proj", "project": "proj", "platform": "flutter"}],
        }
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(seeded, f)
        setup_cipherpol.ensure_workspace_manifest(False, ["/tmp/ws-b"])
        data = self._read()
        self.assertEqual(data["repos"], seeded["repos"])
        self.assertEqual(data["workspace_roots"], ["/tmp/ws-a", "/tmp/ws-b"])

    def test_unreadable_manifest_is_left_alone(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("{ not json")
        setup_cipherpol.ensure_workspace_manifest(False, ["/tmp/ws-a"])
        self.assertIn("WARN", self._statuses())
        with open(self.path, encoding="utf-8") as f:
            self.assertEqual(f.read(), "{ not json")


if __name__ == "__main__":
    unittest.main()
