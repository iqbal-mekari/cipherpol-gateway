export type AdmissionErrorCode =
  | "INVALID_NAMESPACE"
  | "SECRET_DETECTED"
  | "UNSAFE_PATTERN"
  | "DEPENDENCY_CYCLE"
  | "MISSING_DEPENDENCY"
  | "DUPLICATE_PACKAGE_ID"
  | "INVALID_REFERENCE"
  | "INVALID_PROCEDURE_GRAPH"
  | "INVALID_AGENT_CONTEXT"
  | "INVALID_ADMISSION"
  | "ARTIFACT_IO_ERROR"
  | "UNSAFE_ARTIFACT_FILE"
  | "MISSING_SOURCE_FILE"
  | "TARGET_COLLISION"
  | "SIGNATURE_INVALID"
  | "UNTRUSTED_KEY"
  | "DIGEST_MISMATCH"
  | "PROVENANCE_MISMATCH"
  | "PARITY_BASELINE_VIOLATION"
  | "UNMAPPED_PARITY_ID"
  | "UNKNOWN_PACKAGE_REFERENCE"
  | "DUPLICATE_MCP_CAPABILITY"
  | "UNMAPPED_REGISTRY_PACKAGE"
  | "CLOSURE_INVALID"
  | "REGISTRY_INVALID"
  | "ENVELOPE_INVALID"
  | "INVALID_SIGNING_KEY"
  | "REPRODUCIBILITY_MISMATCH"
  | "MODE_MISMATCH";

export class CipherpolAdmissionError extends Error {
  constructor(
    readonly code: AdmissionErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CipherpolAdmissionError";
  }
}
