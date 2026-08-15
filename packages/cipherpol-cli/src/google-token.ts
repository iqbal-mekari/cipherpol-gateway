import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { CliError } from "./errors.js";

const execFileAsync = promisify(execFile);

/**
 * Google's public "Cloud SDK" installed-app OAuth client. It requires no
 * client secret (PKCE proves possession of the code verifier instead), and its
 * ID tokens carry `aud=32555940559.apps.googleusercontent.com` — exactly the
 * control plane's `GOOGLE_AUTH_ALLOWED_AUDIENCE` default, so a token minted
 * here is accepted without any new OAuth client registration.
 */
const GOOGLE_CLIENT_ID = "32555940559.apps.googleusercontent.com";
const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Reject a cached token closer than this to its expiry. */
const TOKEN_SKEW_MS = 60_000;
/** How long to wait for the user to finish the browser consent before giving up. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const storedCredentialsSchema = z.object({
  id_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_at_ms: z.number(),
});
type StoredCredentials = z.infer<typeof storedCredentialsSchema>;

const tokenResponseSchema = z.object({
  id_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
});

/** The token endpoint's response, normalized to the fields the CLI caches. */
interface TokenResult {
  readonly idToken: string;
  readonly refreshToken: string | undefined;
  readonly expiresAtMs: number;
}

/** Test seam so suites can replace the OS browser-open step. */
export type OpenBrowser = (url: string) => Promise<void>;

export interface GoogleAuthOptions {
  readonly openBrowser?: OpenBrowser;
}

function credentialsDir(): string {
  return process.env.CIPHERPOL_CREDENTIALS_DIR ?? join(homedir(), ".cipherpol");
}

function credentialsPath(): string {
  return join(credentialsDir(), "credentials.json");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseStoredCredentials(raw: string): StoredCredentials | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = storedCredentialsSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

function parseTokenResponse(raw: string): TokenResult | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = tokenResponseSchema.safeParse(parsed);
  if (!result.success) return undefined;
  return {
    idToken: result.data.id_token,
    refreshToken: result.data.refresh_token,
    expiresAtMs: Date.now() + Math.floor(result.data.expires_in * 1000),
  };
}

async function readCredentials(): Promise<StoredCredentials | undefined> {
  try {
    return parseStoredCredentials(await readFile(credentialsPath(), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CliError(
      "CREDENTIALS_READ_FAILED",
      `Failed to read Google credentials at ${credentialsPath()}: ${errorMessage(error)}`,
    );
  }
}

/**
 * Writes the credentials file atomically (temp file + rename) so a crash can
 * never leave a half-written `credentials.json` behind, and creates it with
 * mode 0600 so the ID/refresh tokens are readable only by the owner.
 */
async function writeCredentials(credentials: StoredCredentials): Promise<void> {
  const path = credentialsPath();
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await mkdir(credentialsDir(), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw new CliError(
      "CREDENTIALS_WRITE_FAILED",
      `Failed to write Google credentials to ${path}: ${errorMessage(error)}`,
    );
  }
}

async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  let command: string;
  let args: readonly string[];
  if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "win32") {
    // `start` is a cmd.exe built-in, not an executable on PATH.
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  try {
    await execFileAsync(command, [...args]);
  } catch (error) {
    throw new CliError("BROWSER_OPEN_FAILED", `Failed to open a browser for login: ${errorMessage(error)}`);
  }
}

function buildAuthorizationUrl(redirectUri: string, codeChallenge: string, state: string): string {
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

async function requestToken(body: URLSearchParams, what: string): Promise<TokenResult> {
  let response: Response;
  try {
    response = await fetch(process.env.GOOGLE_TOKEN_ENDPOINT ?? DEFAULT_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (error) {
    throw new CliError(
      "TOKEN_ENDPOINT_UNREACHABLE",
      `Failed to reach the Google token endpoint: ${errorMessage(error)}`,
    );
  }
  if (!response.ok) {
    throw new CliError(
      "TOKEN_EXCHANGE_FAILED",
      `Google rejected the ${what} request (HTTP ${response.status}).`,
    );
  }
  const result = parseTokenResponse(await response.text());
  if (result === undefined) {
    throw new CliError(
      "TOKEN_RESPONSE_INVALID",
      `Google returned an unexpected response to the ${what} request.`,
    );
  }
  return result;
}

async function exchangeAuthorizationCode(code: string, redirectUri: string, codeVerifier: string): Promise<TokenResult> {
  return requestToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: GOOGLE_CLIENT_ID,
      code_verifier: codeVerifier,
    }),
    "authorization code",
  );
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
  return requestToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: GOOGLE_CLIENT_ID,
    }),
    "refresh token",
  );
}

interface AuthorizationResult {
  readonly code: string;
  readonly redirectUri: string;
}

/**
 * Spins up a loopback listener, opens the consent URL, and resolves with the
 * authorization code once Google redirects back. Every failure path (open
 * failure, timeout, state mismatch, missing code) settles the same promise and
 * closes the server, so no listener or timer is ever left dangling.
 */
function obtainAuthorizationCode(
  codeChallenge: string,
  state: string,
  open: OpenBrowser,
): Promise<AuthorizationResult> {
  return new Promise<AuthorizationResult>((resolve, reject) => {
    const server = createServer();
    let redirectUri = "";
    let timeout: NodeJS.Timeout | undefined;
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timeout);
      timeout = undefined;
      server.close();
    };

    const fail = (error: CliError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const succeed = (code: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, redirectUri });
    };

    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", redirectUri);
      if (url.searchParams.get("state") !== state) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>Login failed</title><p>State mismatch — close this window and try again.</p>");
        fail(new CliError("LOGIN_STATE_MISMATCH", "Login failed: the OAuth state did not match. Please run `cipherpol login` again."));
        return;
      }
      const code = url.searchParams.get("code");
      if (code === null || code === "") {
        const errorParam = url.searchParams.get("error");
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>Login failed</title><p>Login was not completed — close this window and try again.</p>");
        fail(new CliError(
          "LOGIN_FAILED",
          errorParam !== null
            ? `Login was not completed (Google returned "${errorParam}"). Please run \`cipherpol login\` again.`
            : "Login was not completed (no authorization code returned). Please run `cipherpol login` again.",
        ));
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Login complete</title><p>Login complete — close this window.</p>");
      succeed(code);
    });

    server.once("error", (error) => {
      fail(new CliError("LOGIN_LISTENER_FAILED", `Failed to start the local login listener: ${errorMessage(error)}`));
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        fail(new CliError("LOGIN_LISTENER_FAILED", "Failed to determine the local login listener port."));
        return;
      }
      redirectUri = `http://localhost:${address.port}/`;
      const authorizationUrl = buildAuthorizationUrl(redirectUri, codeChallenge, state);

      timeout = setTimeout(() => {
        fail(new CliError("LOGIN_TIMEOUT", "Timed out waiting for browser login (5 minutes). Please run `cipherpol login` again."));
      }, LOGIN_TIMEOUT_MS);

      open(authorizationUrl).catch((error: unknown) => {
        fail(error instanceof CliError ? error : new CliError("LOGIN_FAILED", `Failed to open the browser: ${errorMessage(error)}`));
      });
    });
  });
}

/** Runs the full PKCE authorization-code flow and returns the fresh tokens. */
async function runBrowserFlow(open: OpenBrowser): Promise<TokenResult> {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");

  const authorization = await obtainAuthorizationCode(codeChallenge, state, open);
  return exchangeAuthorizationCode(authorization.code, authorization.redirectUri, codeVerifier);
}

/**
 * Best-effort extraction of the `email` claim from an ID token, for display
 * only — never used for any trust decision (the gateway is the sole verifier).
 */
export function decodeIdTokenEmail(token: string): string | undefined {
  try {
    const payloadSegment = token.split(".")[1];
    if (payloadSegment === undefined) return undefined;
    const payload: unknown = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
    if (typeof payload !== "object" || payload === null) return undefined;
    if (!("email" in payload)) return undefined;
    const email = payload.email;
    return typeof email === "string" ? email : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns a Google OIDC identity token, preferring a cached credential and
 * only falling back to an interactive browser consent when nothing usable is
 * cached. This is the single auth entrypoint shared by the CLI and (later) the
 * distributable plugin.
 */
export async function getGoogleIdToken(options: GoogleAuthOptions = {}): Promise<string> {
  const stored = await readCredentials();
  if (stored !== undefined && stored.expires_at_ms > Date.now() + TOKEN_SKEW_MS) {
    return stored.id_token;
  }
  if (stored?.refresh_token !== undefined) {
    const refreshed = await refreshAccessToken(stored.refresh_token);
    await writeCredentials({
      id_token: refreshed.idToken,
      refresh_token: refreshed.refreshToken ?? stored.refresh_token,
      expires_at_ms: refreshed.expiresAtMs,
    });
    return refreshed.idToken;
  }
  return login(options);
}

/**
 * Forces an interactive browser consent, ignoring any cached credentials, and
 * caches the resulting tokens. Used by the `cipherpol login` command.
 */
export async function login(options: GoogleAuthOptions = {}): Promise<string> {
  const open = options.openBrowser ?? openBrowser;
  const result = await runBrowserFlow(open);
  if (result.refreshToken === undefined) {
    throw new CliError("LOGIN_FAILED", "Google did not return a refresh token. Please run `cipherpol login` again.");
  }
  await writeCredentials({
    id_token: result.idToken,
    refresh_token: result.refreshToken,
    expires_at_ms: result.expiresAtMs,
  });
  return result.idToken;
}
