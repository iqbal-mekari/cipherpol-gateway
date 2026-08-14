import { CipherpolAdmissionError } from "./errors.js";

export type ArtifactSecurityErrorCode = "SECRET_DETECTED" | "UNSAFE_PATTERN";

export type ArtifactSecurityRuleId =
  | "private-key-delimiter"
  | "anthropic-api-token"
  | "openai-api-token"
  | "github-access-token"
  | "gitlab-access-token"
  | "aws-access-key-id"
  | "google-api-key"
  | "slack-access-token"
  | "stripe-live-secret-key"
  | "ignore-prior-instructions"
  | "override-system-instructions"
  | "reveal-system-instructions";

export interface ArtifactSecurityEvidence {
  readonly filePath: string;
  readonly ruleId: ArtifactSecurityRuleId;
  /** One-based line number. */
  readonly line: number;
  /** One-based UTF-16 column number. */
  readonly column: number;
}

interface ArtifactSecurityRule {
  readonly id: ArtifactSecurityRuleId;
  readonly code: ArtifactSecurityErrorCode;
  readonly pattern: RegExp;
}

// Patterns intentionally omit the global/sticky flags so every line scan is stateless.
const SECURITY_RULES: readonly ArtifactSecurityRule[] = [
  {
    id: "private-key-delimiter",
    code: "SECRET_DETECTED",
    pattern: /-----BEGIN (?:(?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/,
  },
  {
    id: "anthropic-api-token",
    code: "SECRET_DETECTED",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: "stripe-live-secret-key",
    code: "SECRET_DETECTED",
    pattern: /\bsk_live_[A-Za-z0-9]{24,}\b/,
  },
  {
    id: "openai-api-token",
    code: "SECRET_DETECTED",
    pattern: /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: "github-access-token",
    code: "SECRET_DETECTED",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/,
  },
  {
    id: "gitlab-access-token",
    code: "SECRET_DETECTED",
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: "aws-access-key-id",
    code: "SECRET_DETECTED",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    id: "google-api-key",
    code: "SECRET_DETECTED",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    id: "slack-access-token",
    code: "SECRET_DETECTED",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  },
  {
    id: "ignore-prior-instructions",
    code: "UNSAFE_PATTERN",
    pattern: /\b(?:ignore|disregard|forget)\s+(?:(?:all|any|the)\s+)?(?:previous|prior|earlier|above)\s+(?:instructions?|directives?|rules?|prompts?)\b/i,
  },
  {
    id: "override-system-instructions",
    code: "UNSAFE_PATTERN",
    pattern: /\b(?:override|bypass|replace)\s+(?:(?:the|your)\s+)?(?:system|developer)\s+(?:instructions?|directives?|message|prompt)\b/i,
  },
  {
    id: "reveal-system-instructions",
    code: "UNSAFE_PATTERN",
    pattern: /\b(?:reveal|print|show|expose|repeat)\s+(?:(?:the|your)\s+)?(?:hidden\s+)?(?:system|developer)\s+(?:instructions?|message|prompt)\b/i,
  },
];

/**
 * Rejects the first secret or unsafe instruction in an artifact.
 * Error details contain location metadata only and never include matched content.
 */
export function scanArtifactSecurity(filePath: string, content: string): void {
  const lines = content.split(/\r\n|\n|\r/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line === undefined) {
      continue;
    }

    for (const rule of SECURITY_RULES) {
      const match = rule.pattern.exec(line);
      if (match === null) {
        continue;
      }

      const evidence: ArtifactSecurityEvidence = {
        filePath,
        ruleId: rule.id,
        line: lineIndex + 1,
        column: match.index + 1,
      };
      const finding = rule.code === "SECRET_DETECTED" ? "Potential secret credential" : "Unsafe instruction";
      throw new CipherpolAdmissionError(rule.code, `${finding} detected in ${filePath}`, { ...evidence });
    }
  }
}
