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
  CONTROL_PLANE_TRUSTED_PUBLIC_KEY_PEM: z.string().min(1, "CONTROL_PLANE_TRUSTED_PUBLIC_KEY_PEM is required").refine(
    isEd25519PublicKeyPem,
    "CONTROL_PLANE_TRUSTED_PUBLIC_KEY_PEM must be a PEM-encoded Ed25519 public key",
  ),
  CONTROL_PLANE_TRUSTED_KEY_PURPOSE: z.enum(["fixture", "production"], {
    errorMap: () => ({ message: "CONTROL_PLANE_TRUSTED_KEY_PURPOSE must be 'fixture' or 'production'" }),
  }),
  CONTROL_PLANE_ALLOW_FIXTURE_KEYS: z.enum(["true", "false"], {
    errorMap: () => ({ message: "CONTROL_PLANE_ALLOW_FIXTURE_KEYS must be 'true' or 'false' when set" }),
  }).default("false"),
  SUPABASE_JWT_SECRET: z.string().min(1).optional(),
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
  readonly jwtSecret: string | undefined;
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
    jwtSecret: parsed.data.SUPABASE_JWT_SECRET,
  };
}
