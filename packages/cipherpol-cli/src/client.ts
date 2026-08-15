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

const gatewayErrorSchema = z.object({ code: z.string().min(1), message: z.string().min(1) });
const readySchema = z.object({ status: z.enum(["ready", "not_ready"]) });

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
    this.baseUrl = options.baseUrl ?? process.env.CIPHERPOL_GATEWAY_URL ?? "https://cipherpol.iqbalmineraltown.com";
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
}
