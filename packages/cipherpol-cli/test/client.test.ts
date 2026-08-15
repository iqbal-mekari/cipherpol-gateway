import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { TestContext } from "node:test";
import { generationSchema, type CipherpolManifest, type Generation } from "@cipherpol/contracts";
import { GatewayClient, GatewayError } from "../src/client.js";

const TOKEN = "test-google-id-token";

interface CapturedRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly authorization: string | undefined;
  readonly body: string;
}

type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void;

function generation(): Generation {
  return generationSchema.parse({
    schemaVersion: "cipherpol.generation/v1",
    generationId: `sha256:${"a".repeat(64)}`,
    project: "mobile-talenta",
    channel: "stable",
    capabilityPacks: [{ id: "cipherpol.aegis/pack/general", version: "1.0.0" }],
    playbooks: [],
    packages: [{
      id: "cipherpol.aegis/agent/task-router",
      kind: "agent",
      version: "1.0.0",
      digest: `sha256:${"b".repeat(64)}`,
      artifactPath: "artifacts/task-router",
      files: [{ source: "task-router.md", target: "agents/task-router.md" }],
    }],
    toolBundles: [],
    requiredEvidence: [],
  });
}

function manifest(): CipherpolManifest {
  return {
    schemaVersion: "cipherpol.mekari.com/v1",
    project: "mobile-talenta",
    platforms: ["flutter"],
    channel: "stable",
    capabilityPacks: ["cipherpol.aegis/pack/general"],
    playbooks: [],
    policyProfile: "standard",
    owners: ["mobile-platform"],
  };
}

async function startGateway(
  context: TestContext,
  handler: Handler,
): Promise<{ baseUrl: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });
      handler(request, response, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function authenticated(baseUrl: string): GatewayClient {
  return new GatewayClient({ baseUrl, tokenProvider: async () => TOKEN });
}

test("resolveGeneration posts the manifest and client with a bearer token", async (t) => {
  const { baseUrl, requests } = await startGateway(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(generation()));
  });
  const result = await authenticated(baseUrl).resolveGeneration(manifest(), {
    claudeCodeVersion: "2.1.89",
    capabilities: ["plugins"],
  });
  assert.equal(result.generationId, `sha256:${"a".repeat(64)}`);
  assert.equal(requests.length, 1);
  const sent = requests[0]!;
  assert.equal(sent.method, "POST");
  assert.equal(sent.url, "/generations/resolve");
  assert.equal(sent.authorization, `Bearer ${TOKEN}`);
  const payload = JSON.parse(sent.body) as {
    manifest: CipherpolManifest;
    client: { claudeCodeVersion: string; capabilities: string[] };
  };
  assert.equal(payload.manifest.project, "mobile-talenta");
  assert.equal(payload.client.claudeCodeVersion, "2.1.89");
  assert.deepEqual(payload.client.capabilities, ["plugins"]);
});

test("checkHealth is unauthenticated and reports readiness", async (t) => {
  const { baseUrl, requests } = await startGateway(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ready" }));
  });
  const result = await new GatewayClient({ baseUrl }).checkHealth();
  assert.deepEqual(result, { ready: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.authorization, undefined);
  assert.equal(requests[0]!.url, "/health/ready");
});

test("checkHealth maps a 503 to not ready", async (t) => {
  const { baseUrl } = await startGateway(t, (_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "not_ready" }));
  });
  assert.deepEqual(await new GatewayClient({ baseUrl }).checkHealth(), { ready: false });
});

test("resolveGeneration surfaces the server error code and message", async (t) => {
  const { baseUrl } = await startGateway(t, (_request, response) => {
    response.writeHead(422, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "RESOLUTION_FAILED", message: "No compatible package cipherpol.aegis/agent/task-router" }));
  });
  await assert.rejects(
    authenticated(baseUrl).resolveGeneration(manifest(), { claudeCodeVersion: "2.1.89", capabilities: [] }),
    (error: unknown) => error instanceof GatewayError
      && error.status === 422
      && error.code === "RESOLUTION_FAILED"
      && error.message === "No compatible package cipherpol.aegis/agent/task-router",
  );
});

test("resolveGeneration maps an unauthenticated response", async (t) => {
  const { baseUrl } = await startGateway(t, (_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "UNAUTHENTICATED", message: "A valid Google account session is required" }));
  });
  await assert.rejects(
    authenticated(baseUrl).resolveGeneration(manifest(), { claudeCodeVersion: "2.1.89", capabilities: [] }),
    (error: unknown) => error instanceof GatewayError && error.status === 401 && error.code === "UNAUTHENTICATED",
  );
});

test("checkAuthentication reports accepted with the token's email when the gateway accepts the request", async (t) => {
  const fakeToken = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6ImVuZ2luZWVyQG1la2FyaS5jb20ifQ.fakesignature";
  const { baseUrl, requests } = await startGateway(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify([]));
  });
  const client = new GatewayClient({ baseUrl, tokenProvider: async () => fakeToken });
  const result = await client.checkAuthentication();
  assert.deepEqual(result, { accepted: true, email: "engineer@mekari.com" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.method, "GET");
  assert.equal(requests[0]!.url, "/projects");
  assert.equal(requests[0]!.authorization, `Bearer ${fakeToken}`);
});

test("checkAuthentication reports rejected on a 401, distinguishing server rejection from local token failure", async (t) => {
  const { baseUrl } = await startGateway(t, (_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "UNAUTHENTICATED", message: "A valid Google account session is required" }));
  });
  const result = await authenticated(baseUrl).checkAuthentication();
  assert.deepEqual(result, { accepted: false, email: undefined });
});
