import {
  parityManifestV2Schema,
  type ParityBaselineV2,
  type ParityEntryV2,
  type ParityManifestV2,
} from "@cipherpol/contracts";
import { CipherpolAdmissionError } from "./errors.js";

export const SOFTWARE_DEV_AGENTIC_BASELINE: ParityBaselineV2 = {
  userFacing: 34,
  skills: 67,
  agents: 47,
  references: 36,
  cp1Tools: 17,
  classifiedEntries: 167,
  taxonomies: 1,
};

export interface MeasuredParityCounts {
  userFacing: number;
  skills: number;
  agents: number;
  references: number;
  cp1Tools: number;
  classifiedEntries: number;
  taxonomies: number;
}

export function measureParityEntries(entries: readonly ParityEntryV2[]): MeasuredParityCounts {
  let userFacing = 0;
  let skills = 0;
  let agents = 0;
  let references = 0;
  let cp1Tools = 0;
  let taxonomies = 0;

  for (const entry of entries) {
    switch (entry.artifactType) {
      case "orchestrator":
        skills += 1;
        if (entry.userInvocable === true) userFacing += 1;
        break;
      case "internal-procedure":
      case "contract":
        skills += 1;
        break;
      case "agent":
        agents += 1;
        break;
      case "reference":
        references += 1;
        break;
      case "mcp-tool":
        cp1Tools += 1;
        break;
      case "taxonomy":
        taxonomies += 1;
        break;
    }
  }

  return {
    userFacing,
    skills,
    agents,
    references,
    cp1Tools,
    classifiedEntries: skills + agents + references + cp1Tools,
    taxonomies,
  };
}

export function buildParityManifest(
  sourceRevision: string,
  entries: readonly ParityEntryV2[],
): ParityManifestV2 {
  return {
    schemaVersion: "cipherpol.parity/v2",
    sourceMarketplaceRevision: sourceRevision,
    baseline: SOFTWARE_DEV_AGENTIC_BASELINE,
    entries: [...entries].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function verifyParityBaseline(manifest: ParityManifestV2): MeasuredParityCounts {
  const parsed = parityManifestV2Schema.safeParse(manifest);
  if (!parsed.success) {
    throw new CipherpolAdmissionError(
      "PARITY_BASELINE_VIOLATION",
      "Parity manifest does not satisfy cipherpol.parity/v2",
      { issues: parsed.error.issues },
    );
  }

  const measured = measureParityEntries(parsed.data.entries);
  const mismatches = Object.entries(SOFTWARE_DEV_AGENTIC_BASELINE).filter(
    ([field, expected]) => measured[field as keyof MeasuredParityCounts] !== expected,
  );

  if (mismatches.length > 0) {
    throw new CipherpolAdmissionError(
      "PARITY_BASELINE_VIOLATION",
      "Parity baseline counts mismatch; expected 167 classified entries plus one taxonomy",
      { expected: SOFTWARE_DEV_AGENTIC_BASELINE, measured },
    );
  }

  return measured;
}
