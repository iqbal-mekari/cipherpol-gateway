/**
 * A user-facing CLI failure raised by the CLI's own validation and argument
 * handling. `main().catch` prints only `message` for these — never a stack
 * trace — while reserving full stack output for genuinely unexpected errors.
 */
export class CliError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CliError";
  }
}
