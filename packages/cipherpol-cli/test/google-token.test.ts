import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { getGoogleIdToken, login, type OpenBrowser } from "../src/google-token.js";

const GOOGLE_CLIENT_ID = "32555940559.apps.googleusercontent.com";

interface CapturedTokenRequest {
  readonly body: URLSearchParams;
}

interface TokenEndpoint {
  readonly url: string;
  readonly requests: CapturedTokenRequest[];
}

/** A fake Google token endpoint that records each form-encoded request. */
async function startTokenEndpoint(t: TestContext): Promise<TokenEndpoint> {
  const requests: CapturedTokenRequest[] = [];
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = new URLSearchParams(raw);
      requests.push({ body });
      const payload =
        body.get("grant_type") === "refresh_token"
          ? { id_token: "refreshed-id-token", expires_in: 3600 }
          : { id_token: "fresh-id-token", refresh_token: "fresh-refresh-token", expires_in: 3600 };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock token endpoint failed to bind");
  }
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

interface TestEnv {
  readonly credentialsDir: string;
  readonly tokenEndpoint: TokenEndpoint;
}

/** Points the CLI at an isolated credentials dir and the mock token endpoint. */
async function withEnv(t: TestContext): Promise<TestEnv> {
  const credentialsDir = await mkdtemp(join(tmpdir(), "cipherpol-creds-"));
  const tokenEndpoint = await startTokenEndpoint(t);

  const previousCredentialsDir = process.env.CIPHERPOL_CREDENTIALS_DIR;
  const previousTokenEndpoint = process.env.GOOGLE_TOKEN_ENDPOINT;
  process.env.CIPHERPOL_CREDENTIALS_DIR = credentialsDir;
  process.env.GOOGLE_TOKEN_ENDPOINT = tokenEndpoint.url;

  t.after(async () => {
    if (previousCredentialsDir === undefined) delete process.env.CIPHERPOL_CREDENTIALS_DIR;
    else process.env.CIPHERPOL_CREDENTIALS_DIR = previousCredentialsDir;
    if (previousTokenEndpoint === undefined) delete process.env.GOOGLE_TOKEN_ENDPOINT;
    else process.env.GOOGLE_TOKEN_ENDPOINT = previousTokenEndpoint;
    await rm(credentialsDir, { recursive: true, force: true });
  });

  return { credentialsDir, tokenEndpoint };
}

/** An `openBrowser` that plays Google's callback, completing consent. */
function completingOpenBrowser(code: string, onUrl?: (url: URL) => void): OpenBrowser {
  return async (url: string): Promise<void> => {
    const parsed = new URL(url);
    onUrl?.(parsed);
    const redirectUri = parsed.searchParams.get("redirect_uri");
    const state = parsed.searchParams.get("state");
    assert.ok(redirectUri, "authorization URL must carry redirect_uri");
    assert.ok(state, "authorization URL must carry state");
    await fetch(`${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
  };
}

/** Guards cached/refresh tests against an accidental fall-through to a browser. */
const unexpectedBrowser: OpenBrowser = async () => {
  throw new Error("browser flow should not have been reached");
};

async function writeCachedCredentials(
  credentialsDir: string,
  credentials: { id_token: string; refresh_token: string; expires_at_ms: number },
): Promise<void> {
  await mkdir(credentialsDir, { recursive: true });
  await writeFile(join(credentialsDir, "credentials.json"), JSON.stringify(credentials), { mode: 0o600 });
}

test("derives an S256 code_challenge from the code_verifier", async (t) => {
  const env = await withEnv(t);
  let authorizationUrl: URL | undefined;

  const token = await login({ openBrowser: completingOpenBrowser("pkce-code", (url) => {
    authorizationUrl = url;
  }) });
  assert.equal(token, "fresh-id-token");

  assert.ok(authorizationUrl, "openBrowser must have captured the authorization URL");
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  const codeChallenge = authorizationUrl.searchParams.get("code_challenge");
  assert.ok(codeChallenge, "authorization URL must carry code_challenge");

  const request = env.tokenEndpoint.requests[0];
  assert.ok(request, "the authorization code must have been exchanged");
  const codeVerifier = request.body.get("code_verifier");
  assert.ok(codeVerifier, "token exchange must carry code_verifier");
  assert.equal(createHash("sha256").update(codeVerifier).digest("base64url"), codeChallenge);
});

test("exchanges the authorization code with the expected parameters", async (t) => {
  const env = await withEnv(t);
  const token = await login({ openBrowser: completingOpenBrowser("auth-code-123") });
  assert.equal(token, "fresh-id-token");

  const request = env.tokenEndpoint.requests[0];
  assert.ok(request);
  assert.equal(request.body.get("grant_type"), "authorization_code");
  assert.equal(request.body.get("code"), "auth-code-123");
  assert.equal(request.body.get("client_id"), GOOGLE_CLIENT_ID);
  assert.match(request.body.get("redirect_uri") ?? "", /^http:\/\/localhost:\d+\/$/);
  assert.ok(request.body.get("code_verifier"), "token exchange must carry code_verifier");
});

test("caches id_token, refresh_token, and expiry after login", async (t) => {
  const env = await withEnv(t);
  const token = await login({ openBrowser: completingOpenBrowser("cache-code") });
  assert.equal(token, "fresh-id-token");

  const path = join(env.credentialsDir, "credentials.json");
  const stored = JSON.parse(await readFile(path, "utf8")) as {
    id_token?: unknown;
    refresh_token?: unknown;
    expires_at_ms?: unknown;
  };
  assert.equal(stored.id_token, "fresh-id-token");
  assert.equal(stored.refresh_token, "fresh-refresh-token");
  assert.equal(typeof stored.expires_at_ms, "number");

  const info = await stat(path);
  assert.equal(info.mode & 0o777, 0o600, "credentials file must be owner read/write only");
});

test("returns a valid cached token without any network call", async (t) => {
  const env = await withEnv(t);
  await writeCachedCredentials(env.credentialsDir, {
    id_token: "cached-id-token",
    refresh_token: "cached-refresh-token",
    expires_at_ms: Date.now() + 10 * 60 * 1000,
  });

  const token = await getGoogleIdToken({ openBrowser: unexpectedBrowser });
  assert.equal(token, "cached-id-token");
  assert.equal(env.tokenEndpoint.requests.length, 0);
});

test("refreshes an expired token and re-caches, preserving the refresh_token", async (t) => {
  const env = await withEnv(t);
  await writeCachedCredentials(env.credentialsDir, {
    id_token: "expired-id-token",
    refresh_token: "stored-refresh-token",
    expires_at_ms: Date.now() - 1000,
  });

  const token = await getGoogleIdToken({ openBrowser: unexpectedBrowser });
  assert.equal(token, "refreshed-id-token");

  const request = env.tokenEndpoint.requests[0];
  assert.ok(request);
  assert.equal(request.body.get("grant_type"), "refresh_token");
  assert.equal(request.body.get("refresh_token"), "stored-refresh-token");
  assert.equal(request.body.get("client_id"), GOOGLE_CLIENT_ID);

  const stored = JSON.parse(await readFile(join(env.credentialsDir, "credentials.json"), "utf8")) as {
    id_token?: unknown;
    refresh_token?: unknown;
  };
  assert.equal(stored.id_token, "refreshed-id-token");
  assert.equal(stored.refresh_token, "stored-refresh-token");
});

test("rejects the login when the OAuth state does not match", async (t) => {
  const env = await withEnv(t);
  const open: OpenBrowser = async (url: string): Promise<void> => {
    const redirectUri = new URL(url).searchParams.get("redirect_uri");
    assert.ok(redirectUri);
    await fetch(`${redirectUri}?code=anything&state=WRONG`);
  };

  await assert.rejects(
    login({ openBrowser: open }),
    (error: unknown) => error instanceof Error && /state did not match/i.test(error.message),
  );
  assert.equal(env.tokenEndpoint.requests.length, 0, "a state mismatch must never reach the token exchange");
});
