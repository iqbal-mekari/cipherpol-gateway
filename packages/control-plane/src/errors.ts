export type ControlPlaneErrorCode =
  | "INVALID_ENVELOPE"
  | "INGEST_CONFLICT"
  | "UNKNOWN_CHANNEL"
  | "RESOLUTION_FAILED"
  | "PROJECT_CONFLICT"
  | "POLICY_VIOLATION"
  | "POLICY_PROFILE_CONFLICT"
  | "UNKNOWN_PROJECT"
  | "UNKNOWN_POLICY_PROFILE"
  | "UNAUTHENTICATED"
  | "UNKNOWN_SNAPSHOT"
  | "ARTIFACT_MISMATCH";

export class ControlPlaneError extends Error {
  constructor(
    readonly code: ControlPlaneErrorCode,
    readonly httpStatus: number,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ControlPlaneError";
  }
}
