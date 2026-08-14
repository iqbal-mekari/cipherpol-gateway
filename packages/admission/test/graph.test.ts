import assert from "node:assert/strict";
import test from "node:test";
import {
  CipherpolAdmissionError,
  type PackageDependencyNode,
  validateDependencyGraph,
} from "../src/index.js";

function captureAdmissionError(action: () => void): CipherpolAdmissionError {
  try {
    action();
  } catch (error: unknown) {
    assert.ok(error instanceof CipherpolAdmissionError);
    return error;
  }
  return assert.fail("Expected CipherpolAdmissionError");
}

test("rejects duplicate package IDs", () => {
  const error = captureAdmissionError(() => {
    validateDependencyGraph([
      { id: "cipherpol.aegis/agent/a", dependencies: [] },
      { id: "cipherpol.aegis/agent/a", dependencies: [] },
    ]);
  });

  assert.equal(error.code, "DUPLICATE_PACKAGE_ID");
  assert.deepEqual(error.details, {
    packageId: "cipherpol.aegis/agent/a",
    reason: "duplicate-id",
  });
});

test("rejects malformed dependency references", () => {
  const error = captureAdmissionError(() => {
    validateDependencyGraph([
      { id: "cipherpol.aegis/agent/a", dependencies: ["cipherpol.aegis/skill/b"] },
    ]);
  });

  assert.equal(error.code, "INVALID_REFERENCE");
  assert.equal(error.details["reason"], "malformed-reference");
});

test("rejects dependencies absent from the admitted set", () => {
  const error = captureAdmissionError(() => {
    validateDependencyGraph([
      {
        id: "cipherpol.aegis/agent/a",
        dependencies: ["cipherpol.aegis/skill/missing@1.0.0"],
      },
    ]);
  });

  assert.equal(error.code, "MISSING_DEPENDENCY");
  assert.deepEqual(error.details, {
    packageId: "cipherpol.aegis/agent/a",
    dependencyId: "cipherpol.aegis/skill/missing",
    reference: "cipherpol.aegis/skill/missing@1.0.0",
    reason: "dependency-not-admitted",
  });
});

test("reports deterministic cycle details independent of registry order", () => {
  const forward: PackageDependencyNode[] = [
    {
      id: "cipherpol.aegis/agent/a",
      dependencies: ["cipherpol.aegis/agent/c@1.0.0", "cipherpol.aegis/agent/b@1.0.0"],
    },
    {
      id: "cipherpol.aegis/agent/b",
      dependencies: ["cipherpol.aegis/agent/a@1.0.0"],
    },
    {
      id: "cipherpol.aegis/agent/c",
      dependencies: ["cipherpol.aegis/agent/a@1.0.0"],
    },
  ];
  const reversed = [...forward]
    .reverse()
    .map((node) => ({ ...node, dependencies: [...node.dependencies].reverse() }));

  const first = captureAdmissionError(() => {
    validateDependencyGraph(forward);
  });
  const second = captureAdmissionError(() => {
    validateDependencyGraph(reversed);
  });

  assert.equal(first.code, "DEPENDENCY_CYCLE");
  assert.deepEqual(first.details, {
    cycle: [
      "cipherpol.aegis/agent/a",
      "cipherpol.aegis/agent/b",
      "cipherpol.aegis/agent/a",
    ],
  });
  assert.deepEqual(second.details, first.details);
});

test("validates an acyclic graph independent of registry order", () => {
  const nodes: PackageDependencyNode[] = [
    {
      id: "cipherpol.aegis/agent/a",
      dependencies: ["cipherpol.aegis/skill/b@1.0.0"],
    },
    { id: "cipherpol.aegis/skill/b", dependencies: [] },
  ];

  assert.doesNotThrow(() => {
    validateDependencyGraph(nodes);
  });
  assert.doesNotThrow(() => {
    validateDependencyGraph([...nodes].reverse());
  });
});

test("parses dependency references at the final at-sign", () => {
  assert.doesNotThrow(() => {
    validateDependencyGraph([
      { id: "cipherpol.aegis/agent/a", dependencies: ["@cipherpol/skill-b@1.0.0"] },
      { id: "@cipherpol/skill-b", dependencies: [] },
    ]);
  });
});
