import { createPublicKey } from "node:crypto";
import { z } from "zod";

function isServiceRoleKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) return true;
  if (key.startsWith("sb_publishable_")) return false;
  const segments = key.split(".");
  if (segments.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8")) as { role?: unknown };
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

function isEd25519PublicKeyPem(pem: string): boolean {
  try {
    const key = createPublicKey(pem);
    return key.type === "public" && key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

const envSchema = z.object({
  SUPABASE_URL: z.string().url("SUPABASE_URL must be an explicit URL"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).refine(
    isServiceRoleKey,
    "SUPABASE_SERVICE_ROLE_KEY must be the service-role key, not a publishable/anon key",
  ),
  PORT: z.string().regex(/^\d+$/).default("4100"),
  CONTROL_PLANE_TRUSTED_KEY_ID: z.string().min(1, "CONTROL_PLANE_TRUSTED_KEY_ID is required"),
  // `.transform` accepts the PEM either verbatim (real newlines — a multi-line source like a
  // test fixture file, or an env-file format with genuine multi-line value support) or
  // base64-encoded on a single line. Base64 is the recommended production form: systemd's
  // `EnvironmentFile` does its own backslash-escape processing on values and silently mangles a
  // literal `\n` two-character sequence (strips the backslash, leaves a bare `n` — confirmed
  // against systemd 256 via `systemd-run -p EnvironmentFile=...`), so a `\n`-escaping convention
  // is not actually portable to this project's real deployment target. Base64's alphabet has no
  // backslashes to mangle and is unambiguous everywhere. "-----BEGIN" is not valid base64
  // (base64 never emits a leading `-`), so detecting a literal PEM is safe.
  CONTROL_PLANE_TRUSTED_PUBLIC_KEY_PEM: z.string().min(1, "CONTROL_PLANE_TRUSTED_PUBLIC_KEY_PEM is required")
    .transform((value) => (
      value.trimStart().startsWith("-----BEGIN") ? value : Buffer.from(value, "base64").toString("utf8")
    ))
    .refine(isEd25519PublicKeyPem, "CONTROL_PLANE_TRUSTED_PUBLIC_KEY_PEM must be a PEM-encoded Ed25519 public key (verbatim or base64-encoded)"),
  CONTROL_PLANE_TRUSTED_KEY_PURPOSE: z.enum(["fixture", "production"], {
    errorMap: () => ({ message: "CONTROL_PLANE_TRUSTED_KEY_PURPOSE must be 'fixture' or 'production'" }),
  }),
  CONTROL_PLANE_ALLOW_FIXTURE_KEYS: z.enum(["true", "false"], {
    errorMap: () => ({ message: "CONTROL_PLANE_ALLOW_FIXTURE_KEYS must be 'true' or 'false' when set" }),
  }).default("false"),
  // Every route except /health and /health/ready requires a Google ID token
  // whose `email` ends with `@<this domain>` (see google-auth.ts/server.ts's
  // global auth gate). No default: an empty/misconfigured allowlist domain
  // must fail loudly at boot, never silently accept every domain.
  GOOGLE_AUTH_ALLOWED_EMAIL_DOMAIN: z.string().min(1, "GOOGLE_AUTH_ALLOWED_EMAIL_DOMAIN is required"),
});

/**
 * The server-pinned root of trust for verifying ingested registry/admission
 * envelopes: resolved once at boot from control-plane configuration/environment,
 * exactly analogous to how the Stage 2 `verify-closure` CLI takes
 * `--public-key`/`--key-id` from operator-controlled local flags rather than from
 * the artifact being verified. Never influenced by request-body content.
 */
export interface ControlPlaneEnv {
  readonly supabaseUrl: string;
  readonly supabaseServiceRoleKey: string;
  readonly port: number;
  readonly trustedKeyId: string;
  readonly trustedPublicKeyPem: string;
  readonly trustedKeyPurpose: "fixture" | "production";
  readonly allowFixtureKeys: boolean;
  readonly googleAuthAllowedEmailDomain: string;
}

export function loadControlPlaneEnv(source: Record<string, string | undefined>): ControlPlaneEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid control-plane environment (${missing}): ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return {
    supabaseUrl: parsed.data.SUPABASE_URL,
    supabaseServiceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
    port: Number(parsed.data.PORT),
    trustedKeyId: parsed.data.CONTROL_PLANE_TRUSTED_KEY_ID,
    trustedPublicKeyPem: parsed.data.CONTROL_PLANE_TRUSTED_PUBLIC_KEY_PEM,
    trustedKeyPurpose: parsed.data.CONTROL_PLANE_TRUSTED_KEY_PURPOSE,
    allowFixtureKeys: parsed.data.CONTROL_PLANE_ALLOW_FIXTURE_KEYS === "true",
    googleAuthAllowedEmailDomain: parsed.data.GOOGLE_AUTH_ALLOWED_EMAIL_DOMAIN,
  };
}
