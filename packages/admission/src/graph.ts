import { CipherpolAdmissionError } from "./errors.js";

export interface PackageDependencyNode {
  readonly id: string;
  readonly dependencies: readonly string[];
}

function parseDependencyId(reference: string): string | undefined {
  const separatorIndex = reference.lastIndexOf("@");
  if (
    separatorIndex <= 0 ||
    separatorIndex === reference.length - 1 ||
    /\s/.test(reference)
  ) {
    return undefined;
  }

  return reference.slice(0, separatorIndex);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Validates package identity and dependency edges, then proves the graph is acyclic.
 * Node and edge traversal is sorted so diagnostics do not depend on registry order.
 */
export function validateDependencyGraph(nodes: readonly PackageDependencyNode[]): void {
  const sortedNodes = [...nodes].sort((left, right) => compareStrings(left.id, right.id));
  const graph = new Map<string, readonly string[]>();

  for (const node of sortedNodes) {
    if (graph.has(node.id)) {
      throw new CipherpolAdmissionError(
        "DUPLICATE_PACKAGE_ID",
        `Duplicate admitted package ID: ${node.id}`,
        { packageId: node.id, reason: "duplicate-id" },
      );
    }
    graph.set(node.id, []);
  }

  for (const node of sortedNodes) {
    const dependencyIds = new Set<string>();
    const sortedReferences = [...node.dependencies].sort(compareStrings);

    for (const reference of sortedReferences) {
      const dependencyId = parseDependencyId(reference);
      if (dependencyId === undefined) {
        throw new CipherpolAdmissionError(
          "INVALID_REFERENCE",
          `Malformed dependency reference declared by ${node.id}`,
          { packageId: node.id, reference, reason: "malformed-reference" },
        );
      }
      if (!graph.has(dependencyId)) {
        throw new CipherpolAdmissionError(
          "MISSING_DEPENDENCY",
          `Dependency ${dependencyId} declared by ${node.id} is not admitted`,
          {
            packageId: node.id,
            dependencyId,
            reference,
            reason: "dependency-not-admitted",
          },
        );
      }
      dependencyIds.add(dependencyId);
    }

    graph.set(node.id, [...dependencyIds].sort(compareStrings));
  }

  const visited = new Set<string>();
  const activeIndexes = new Map<string, number>();
  const path: string[] = [];

  function visit(nodeId: string): void {
    activeIndexes.set(nodeId, path.length);
    path.push(nodeId);

    const dependencies = graph.get(nodeId)!;

    for (const dependencyId of dependencies) {
      const cycleStart = activeIndexes.get(dependencyId);
      if (cycleStart !== undefined) {
        const cycle = [...path.slice(cycleStart), dependencyId];
        throw new CipherpolAdmissionError(
          "DEPENDENCY_CYCLE",
          `Dependency cycle detected: ${cycle.join(" -> ")}`,
          { cycle },
        );
      }
      if (!visited.has(dependencyId)) {
        visit(dependencyId);
      }
    }

    path.pop();
    activeIndexes.delete(nodeId);
    visited.add(nodeId);
  }

  for (const nodeId of graph.keys()) {
    if (!visited.has(nodeId)) {
      visit(nodeId);
    }
  }
}
