import { generationSchema, type CipherpolManifest, type Generation } from "@cipherpol/contracts";
import { z } from "zod";
import { getGoogleIdToken } from "./google-token.js";

export interface ResolveClient {
  readonly claudeCodeVersion: string;
  readonly capabilities: readonly string[];
}

/**
 * A typed error surfacing the control plane's stable `{ code, message }` error
 * body rather than a generic `fetch` error, so callers can branch on the
 * server-declared error code.
 */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export interface GatewayClientOptions {
  readonly baseUrl?: string;
  /** Test seam: defaults to `getGoogleIdToken`, so real callers never pass this. */
  readonly tokenProvider?: () => Promise<string>;
}

/**
 * The result of proving the caller's Google identity is accepted by the
 * gateway. A `401`/`403` is a genuine identity rejection (`accepted: false`
 * with that status); any other non-2xx is surfaced with its `httpStatus` so
 * callers do not blame the user's identity/domain for a transient server
 * error.
 */
export type AuthenticationResult =
  | { readonly accepted: true; readonly email: string | undefined }
  | { readonly accepted: false; readonly httpStatus: number };

/** The slice of a registry snapshot the CLI needs to materialize a generation. */
export interface RegistrySnapshot {
  readonly registryEnvelope: {
    readonly closureManifest: {
      readonly mappings: ReadonlyArray<{ readonly packageId: string; readonly admissionPath: string }>;
    };
  };
  readonly admissionEnvelopes: Readonly<Record<string, unknown>>;
}

const gatewayErrorSchema = z.object({ code: z.string().min(1), message: z.string().min(1) });
const readySchema = z.object({ status: z.enum(["ready", "not_ready"]) });
const snapshotSchema = z.object({
  registryEnvelope: z.object({
    closureManifest: z.object({
      mappings: z.array(z.object({ packageId: z.string().min(1), admissionPath: z.string().min(1) })),
    }),
  }),
  admissionEnvelopes: z.record(z.string(), z.unknown()),
});

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export class GatewayClient {
  readonly baseUrl: string;
  private readonly tokenProvider: () => Promise<string>;

  constructor(options: GatewayClientOptions = {}) {
    const baseUrl = options.baseUrl ?? process.env.CIPHERPOL_GATEWAY_URL ?? "https://cipherpol.iqbalmineraltown.com";
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.tokenProvider = options.tokenProvider ?? getGoogleIdToken;
  }

  async resolveGeneration(manifest: CipherpolManifest, client: ResolveClient): Promise<Generation> {
    const token = await this.tokenProvider();
    const response = await fetch(`${this.baseUrl}/generations/resolve`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        manifest,
        client: {
          claudeCodeVersion: client.claudeCodeVersion,
          capabilities: [...client.capabilities],
        },
      }),
    });
    const body = await readJson(response);
    if (!response.ok) {
      const parsed = gatewayErrorSchema.safeParse(body);
      if (parsed.success) throw new GatewayError(response.status, parsed.data.code, parsed.data.message);
      throw new GatewayError(response.status, "HTTP_ERROR", `Request failed with status ${response.status}`);
    }
    const parsed = generationSchema.safeParse(body);
    if (!parsed.success) {
      throw new GatewayError(response.status, "INVALID_RESPONSE", `Gateway returned an invalid generation: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  async checkHealth(): Promise<{ ready: boolean }> {
    const response = await fetch(`${this.baseUrl}/health/ready`);
    if (!response.ok) return { ready: false };
    const body = await readJson(response);
    const parsed = readySchema.safeParse(body);
    return { ready: parsed.success && parsed.data.status === "ready" };
  }

  /**
   * Proves the caller's Google identity is actually ACCEPTED by the gateway —
   * not merely that a token could be minted locally. `gcloud auth
   * print-identity-token` succeeding only proves the caller is signed in to
   * *some* Google account; it says nothing about whether that account's email
   * domain passes the gateway's allowlist. `GET /projects` is used because it
   * requires no request body/params and always returns 200 for any accepted
   * identity regardless of what data exists.
   */
  async checkAuthentication(): Promise<AuthenticationResult> {
    const token = await this.tokenProvider();
    const response = await fetch(`${this.baseUrl}/projects`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.ok) return { accepted: true, email: decodeJwtPayloadEmail(token) };
    return { accepted: false, httpStatus: response.status };
  }

  async getSnapshot(channel: string): Promise<RegistrySnapshot> {
    const token = await this.tokenProvider();
    const response = await fetch(`${this.baseUrl}/registry/snapshots/${encodeURIComponent(channel)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await readJson(response);
    if (!response.ok) {
      const parsed = gatewayErrorSchema.safeParse(body);
      if (parsed.success) throw new GatewayError(response.status, parsed.data.code, parsed.data.message);
      throw new GatewayError(response.status, "HTTP_ERROR", `Request failed with status ${response.status}`);
    }
    const parsed = snapshotSchema.safeParse(body);
    if (!parsed.success) {
      throw new GatewayError(response.status, "INVALID_RESPONSE", `Gateway returned an invalid snapshot: ${parsed.error.message}`);
    }
    return parsed.data;
  }
}

/** Best-effort extraction of the `email` claim for display only — never used for any trust decision (the gateway is the sole verifier). */
function decodeJwtPayloadEmail(token: string): string | undefined {
  try {
    const payloadSegment = token.split(".")[1];
    if (payloadSegment === undefined) return undefined;
    const payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as { email?: unknown };
    return typeof payload.email === "string" ? payload.email : undefined;
  } catch {
    return undefined;
  }
}
