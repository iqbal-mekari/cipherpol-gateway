export type ControlPlaneErrorCode =
  | "INVALID_ENVELOPE"
  | "INGEST_CONFLICT"
  | "UNKNOWN_CHANNEL"
  | "RESOLUTION_FAILED";

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
