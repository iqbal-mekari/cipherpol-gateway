import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  checkAgentContext,
  checkProcedures,
  CipherpolAdmissionError,
} from "../src/index.js";

interface FlatViewFixture {
  readonly skills?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly agents?: Readonly<Record<string, string>>;
}

function withFlatView<T>(fixture: FlatViewFixture, action: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "cipherpol-admission-checks-"));
  try {
    const skillsDirectory = join(root, "skills");
    const agentsDirectory = join(root, "agents");
    mkdirSync(skillsDirectory);
    mkdirSync(agentsDirectory);

    for (const [skillName, files] of Object.entries(fixture.skills ?? {})) {
      const skillDirectory = join(skillsDirectory, skillName);
      mkdirSync(skillDirectory);
      for (const [fileName, content] of Object.entries(files)) {
        writeFileSync(join(skillDirectory, fileName), content);
      }
    }
    for (const [fileName, content] of Object.entries(fixture.agents ?? {})) {
      writeFileSync(join(agentsDirectory, fileName), content);
    }

    return action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function captureAdmissionError(action: () => void): CipherpolAdmissionError {
  try {
    action();
  } catch (error: unknown) {
    assert.ok(error instanceof CipherpolAdmissionError);
    return error;
  }
  return assert.fail("Expected CipherpolAdmissionError");
}

function violationKinds(error: CipherpolAdmissionError): string[] {
  const violations = error.details.violations;
  assert.ok(Array.isArray(violations));
  return violations.map((violation: unknown) => {
    assert.ok(typeof violation === "object" && violation !== null && "kind" in violation);
    const kind = violation.kind;
    assert.ok(typeof kind === "string");
    return kind;
  });
}

const CALL_TARGET = "cat $CLAUDE_PLUGIN_ROOT/skills/target/procedure.md";

// Shipping regression 1: an unmodified, internally consistent flat build passes.
test("procedure control fixture passes with a structured report", () => {
  withFlatView(
    {
      skills: {
        caller: {
          "SKILL.md": `allowed-tools: Read\n${CALL_TARGET}`,
        },
        target: {
          "SKILL.md": "allowed-tools: Read",
          "procedure.md": "> Executed by:\n> - `/caller` — composes this procedure",
        },
      },
    },
    (root) => {
      assert.deepEqual(checkProcedures(join(root, "skills")), {
        skillCount: 2,
        procedureCount: 1,
        includeEdgeCount: 1,
      });
    },
  );
});

// Shipping regression 2: every real include edge must be declared by its target.
test("procedure check rejects an include omitted from a nonempty banner", () => {
  withFlatView(
    {
      skills: {
        "caller-a": { "SKILL.md": CALL_TARGET },
        "caller-b": { "SKILL.md": CALL_TARGET },
        target: {
          "SKILL.md": "# target",
          "procedure.md": "> Executed by:\n> - `/caller-b` — retained declaration",
        },
      },
    },
    (root) => {
      const error = captureAdmissionError(() => checkProcedures(join(root, "skills")));
      assert.equal(error.code, "INVALID_PROCEDURE_GRAPH");
      assert.ok(violationKinds(error).includes("banner-omits-caller"));
      assert.match(error.message, /target\/procedure\.md.*caller-a/);
    },
  );
});

// Shipping regression 3: every banner declaration must correspond to a real edge.
test("procedure check rejects a stale banner declaration", () => {
  withFlatView(
    {
      skills: {
        caller: { "SKILL.md": CALL_TARGET },
        idle: { "SKILL.md": "# does not compose target" },
        target: {
          "SKILL.md": "# target",
          "procedure.md": [
            "> Executed by:",
            "> - `/caller` — real edge",
            "> - `/idle` — stale edge",
          ].join("\n"),
        },
      },
    },
    (root) => {
      const error = captureAdmissionError(() => checkProcedures(join(root, "skills")));
      assert.equal(error.code, "INVALID_PROCEDURE_GRAPH");
      assert.ok(violationKinds(error).includes("stale-banner-caller"));
      assert.match(error.message, /target\/procedure\.md.*idle/);
    },
  );
});

// Shipping regression 4: grants cover tools required by the transitive closure.
test("procedure check rejects a transitive allowed-tools gap", () => {
  withFlatView(
    {
      skills: {
        caller: {
          "SKILL.md": "allowed-tools: Read\ncat $CLAUDE_PLUGIN_ROOT/skills/middle/procedure.md",
        },
        middle: {
          "SKILL.md": "allowed-tools: Read, AskUserQuestion",
          "procedure.md": [
            "> Executed by:",
            "> - `/caller` — first hop",
            "cat $CLAUDE_PLUGIN_ROOT/skills/target/procedure.md",
          ].join("\n"),
        },
        target: {
          "SKILL.md": "allowed-tools: AskUserQuestion",
          "procedure.md": "> Executed by:\n> - `/middle` — second hop",
        },
      },
    },
    (root) => {
      const error = captureAdmissionError(() => checkProcedures(join(root, "skills")));
      assert.equal(error.code, "INVALID_PROCEDURE_GRAPH");
      assert.deepEqual(violationKinds(error), ["missing-tool-grant"]);
      assert.match(error.message, /caller\/SKILL\.md.*AskUserQuestion/);
    },
  );
});

// Shipping regression 5: a tool-waiver is load-bearing and tool-specific.
test("procedure check accepts a tool waiver and rejects the same graph without it", () => {
  const target = {
    "SKILL.md": "allowed-tools: AskUserQuestion",
    "procedure.md": "> Executed by:\n> - `/caller` — composed",
  };

  withFlatView(
    {
      skills: {
        caller: {
          "SKILL.md": `allowed-tools: Read\n<!-- tool-waiver: AskUserQuestion — unreachable -->\n${CALL_TARGET}`,
        },
        target,
      },
    },
    (root) => {
      assert.doesNotThrow(() => checkProcedures(join(root, "skills")));
    },
  );

  withFlatView(
    {
      skills: {
        caller: { "SKILL.md": `allowed-tools: Read\n${CALL_TARGET}` },
        target,
      },
    },
    (root) => {
      const error = captureAdmissionError(() => checkProcedures(join(root, "skills")));
      assert.deepEqual(violationKinds(error), ["missing-tool-grant"]);
    },
  );
});

// Shipping regression 6: a procedure banner must contain at least one caller name.
test("procedure check rejects an empty Executed by banner", () => {
  withFlatView(
    {
      skills: {
        target: {
          "SKILL.md": "# target",
          "procedure.md": "> Executed by:\n> explanatory prose without a caller",
        },
      },
    },
    (root) => {
      const error = captureAdmissionError(() => checkProcedures(join(root, "skills")));
      assert.deepEqual(violationKinds(error), ["missing-banner"]);
      assert.match(error.message, /target\/procedure\.md/);
    },
  );
});

// Shipping regression 7: all names left of the em dash are declarations.
test("procedure check resolves every caller in a multi-name banner bullet", () => {
  withFlatView(
    {
      skills: {
        "caller-a": { "SKILL.md": CALL_TARGET },
        "caller-b": { "SKILL.md": CALL_TARGET },
        target: {
          "SKILL.md": "# target",
          "procedure.md": "> Executed by:\n> - `/caller-a` and `/caller-b` — shared procedure",
        },
      },
    },
    (root) => {
      assert.deepEqual(checkProcedures(join(root, "skills")), {
        skillCount: 3,
        procedureCount: 1,
        includeEdgeCount: 2,
      });
    },
  );
});

test("procedure check rejects a literal include whose target procedure is absent", () => {
  withFlatView(
    {
      skills: {
        caller: {
          "SKILL.md": "cat $CLAUDE_PLUGIN_ROOT/skills/missing-target/procedure.md",
        },
      },
    },
    (root) => {
      const error = captureAdmissionError(() => checkProcedures(join(root, "skills")));
      assert.deepEqual(violationKinds(error), ["missing-procedure"]);
      assert.match(error.message, /caller.*missing-target.*caller\/SKILL\.md/);
    },
  );
});

test("procedure include discovery is literal and limited to executable Markdown", () => {
  withFlatView(
    {
      skills: {
        caller: {
          "SKILL.md": "cat CLAUDE_PLUGIN_ROOT/skills/missing/procedure.md",
          "reference.md": "cat $CLAUDE_PLUGIN_ROOT/skills/missing/procedure.md",
        },
      },
    },
    (root) => {
      assert.deepEqual(checkProcedures(join(root, "skills")), {
        skillCount: 1,
        procedureCount: 0,
        includeEdgeCount: 0,
      });
    },
  );
});

test("procedure closure traversal safely handles cycles and self edges", () => {
  withFlatView(
    {
      skills: {
        a: {
          "SKILL.md": "allowed-tools: Read\ncat $CLAUDE_PLUGIN_ROOT/skills/b/procedure.md",
          "procedure.md": [
            "> Executed by:",
            "> - `/b` — cycle",
            "> - `/a` — self edge",
            "cat $CLAUDE_PLUGIN_ROOT/skills/a/procedure.md",
          ].join("\n"),
        },
        b: {
          "SKILL.md": "allowed-tools: Read\ncat $CLAUDE_PLUGIN_ROOT/skills/a/procedure.md",
          "procedure.md": "> Executed by:\n> - `/a` — cycle",
        },
      },
    },
    (root) => {
      assert.deepEqual(checkProcedures(join(root, "skills")), {
        skillCount: 2,
        procedureCount: 2,
        includeEdgeCount: 3,
      });
    },
  );
});

test("agent context accepts a scoped developer search agent", () => {
  withFlatView(
    {
      agents: {
        "developer-scout.md": "tools: Read, Glob\nSearch only beneath literal project_root.",
      },
    },
    (root) => {
      assert.deepEqual(checkAgentContext(join(root, "agents")), {
        agentFileCount: 1,
        searchAgentsChecked: 1,
        waivedSearchAgents: 0,
        pendingSearchAgents: 0,
      });
    },
  );
});

test("agent context rejects an enforced search agent missing literal project_root", () => {
  withFlatView(
    {
      agents: {
        "developer-scout.md": "tools: Grep\nSearch beneath project-root.",
      },
    },
    (root) => {
      const error = captureAdmissionError(() => checkAgentContext(join(root, "agents")));
      assert.equal(error.code, "INVALID_AGENT_CONTEXT");
      assert.deepEqual(violationKinds(error), ["missing-project-root"]);
      assert.match(error.message, /developer-scout\.md.*project_root/);
    },
  );
});

test("agent context accepts a nonempty context waiver", () => {
  withFlatView(
    {
      agents: {
        "aegis-external-scout.md": "tools: Read, Grep\ncontext-waiver: receives absolute paths",
      },
    },
    (root) => {
      assert.deepEqual(checkAgentContext(join(root, "agents")), {
        agentFileCount: 1,
        searchAgentsChecked: 1,
        waivedSearchAgents: 1,
        pendingSearchAgents: 0,
      });
    },
  );
});

test("agent context always rejects both forbidden derivations for enforced prefixes", () => {
  withFlatView(
    {
      agents: {
        "aegis-scout.md": [
          "No tools declaration is needed for this invariant.",
          "git rev-parse --show-toplevel",
          "basename $(pwd)",
        ].join("\n"),
      },
    },
    (root) => {
      const error = captureAdmissionError(() => checkAgentContext(join(root, "agents")));
      assert.equal(error.code, "INVALID_AGENT_CONTEXT");
      assert.deepEqual(violationKinds(error), [
        "forbidden-root-derivation",
        "forbidden-root-derivation",
      ]);
      assert.match(error.message, /aegis-scout\.md.*git rev-parse --show-toplevel/);
      assert.match(error.message, /aegis-scout\.md.*basename \$\(pwd\)/);
    },
  );
});

test("agent context reports unscoped qa search agents as pending without failing", () => {
  withFlatView(
    {
      agents: {
        "qa-scout.md": "tools: Read, Glob\nSearch the supplied area.",
      },
    },
    (root) => {
      assert.deepEqual(checkAgentContext(join(root, "agents")), {
        agentFileCount: 1,
        searchAgentsChecked: 0,
        waivedSearchAgents: 0,
        pendingSearchAgents: 1,
      });
    },
  );
});

test("agent context recognizes only exact Glob and Grep tokens on a one-line tools field", () => {
  withFlatView(
    {
      agents: {
        "developer-near-match.md": "tools: Read, Grepper\nNo project root input.",
        "developer-multiline.md": "tools:\n  - Glob\nNo project root input.",
      },
    },
    (root) => {
      assert.deepEqual(checkAgentContext(join(root, "agents")), {
        agentFileCount: 2,
        searchAgentsChecked: 0,
        waivedSearchAgents: 0,
        pendingSearchAgents: 0,
      });
    },
  );
});

test("required flat views fail closed when absent", () => {
  withFlatView({}, (root) => {
    const procedureError = captureAdmissionError(
      () => checkProcedures(join(root, "missing-skills")),
    );
    assert.equal(procedureError.code, "INVALID_PROCEDURE_GRAPH");
    assert.equal(procedureError.details.reason, "missing-skills-view");

    const agentError = captureAdmissionError(
      () => checkAgentContext(join(root, "missing-agents")),
    );
    assert.equal(agentError.code, "INVALID_AGENT_CONTEXT");
    assert.equal(agentError.details.reason, "missing-agents-view");
  });
});
