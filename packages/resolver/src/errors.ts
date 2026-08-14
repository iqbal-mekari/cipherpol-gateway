export type ErrorCode = "INVALID_MANIFEST" | "INVALID_REGISTRY" | "UNRESOLVABLE_GENERATION" |
  "ARTIFACT_MISMATCH" | "TARGET_COLLISION" | "UNSAFE_PATH" | "UNSAFE_ARTIFACT_FILE" | "ARTIFACT_CHANGED";
export class CipherpolError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message); this.name = "CipherpolError";
  }
}
