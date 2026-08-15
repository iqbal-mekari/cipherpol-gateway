import { CliError } from "./errors.js";

const VALUE_FLAGS: Record<string, true> = {
  "--claude-version": true,
  "--capability": true,
  "--registry": true,
  "--source-root": true,
  "--closure": true,
  "--channel": true,
};
const BOOLEAN_FLAGS: Record<string, true> = {
  "--yes": true,
  "--check": true,
};

export interface ParsedOptions {
  /** Each recognized value flag mapped to every value supplied, in order. */
  readonly values: ReadonlyMap<string, readonly string[]>;
  /** Boolean flags that were present. */
  readonly flags: ReadonlySet<string>;
}

/**
 * Parses the CLI's option list with an explicit indexed loop: a recognized
 * value flag consumes the NEXT token as its value. A missing value, a value
 * that itself starts with `--`, an unknown flag, and the `--flag=value`
 * compact form all fail with a clear `CliError` instead of being silently
 * dropped. `--capability` accumulates every occurrence.
 */
export function parseOptions(args: readonly string[]): ParsedOptions {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();

  const push = (flag: string, optionValue: string): void => {
    const existing = values.get(flag);
    if (existing === undefined) values.set(flag, [optionValue]);
    else existing.push(optionValue);
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== undefined && BOOLEAN_FLAGS[flag] === true) {
      if (flags.has(flag)) throw new CliError("USAGE", `${flag} may be specified only once`);
      flags.add(flag);
      continue;
    }
    if (flag === undefined || VALUE_FLAGS[flag] !== true) {
      throw new CliError("USAGE", `Unknown option: ${flag ?? "<missing>"}`);
    }
    const optionValue = args[index + 1];
    if (optionValue === undefined || optionValue.startsWith("--")) {
      throw new CliError("USAGE", `${flag} requires a value`);
    }
    push(flag, optionValue);
    index += 1;
  }

  return { values, flags };
}
