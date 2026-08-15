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

test("checkAuthentication reports rejection with the 401 status, distinguishing server rejection from local token failure", async (t) => {
  const { baseUrl } = await startGateway(t, (_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "UNAUTHENTICATED", message: "A valid Google account session is required" }));
  });
  const result = await authenticated(baseUrl).checkAuthentication();
  assert.deepEqual(result, { accepted: false, httpStatus: 401 });
});

test("checkAuthentication surfaces a 5xx as a failed check rather than an identity rejection", async (t) => {
  const { baseUrl } = await startGateway(t, (_request, response) => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "INTERNAL_ERROR", message: "boom" }));
  });
  const result = await authenticated(baseUrl).checkAuthentication();
  assert.deepEqual(result, { accepted: false, httpStatus: 500 });
});

test("getSnapshot fetches the channel snapshot with a bearer token", async (t) => {
  const { baseUrl, requests } = await startGateway(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      registryEnvelope: {
        closureManifest: {
          mappings: [{ packageId: "cipherpol.1/adapter/cp1", admissionPath: "admissions/cipherpol.1/adapter/cp1.json" }],
        },
      },
      admissionEnvelopes: {
        "admissions/cipherpol.1/adapter/cp1.json": { provenance: { sourcePaths: ["cipherpol-1/x"], sourceRevision: "a8afa8dd" } },
      },
    }));
  });
  const result = await authenticated(baseUrl).getSnapshot("stable");
  assert.equal(result.registryEnvelope.closureManifest.mappings.length, 1);
  assert.equal(result.registryEnvelope.closureManifest.mappings[0]!.packageId, "cipherpol.1/adapter/cp1");
  assert.equal(result.admissionEnvelopes["admissions/cipherpol.1/adapter/cp1.json"] !== undefined, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.method, "GET");
  assert.equal(requests[0]!.url, "/registry/snapshots/stable");
  assert.equal(requests[0]!.authorization, `Bearer ${TOKEN}`);
});

test("normalizes a trailing-slash baseUrl", async (t) => {
  const { baseUrl, requests } = await startGateway(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(generation()));
  });
  const client = new GatewayClient({ baseUrl: `${baseUrl}/`, tokenProvider: async () => TOKEN });
  assert.equal(client.baseUrl, baseUrl);
  await client.resolveGeneration(manifest(), { claudeCodeVersion: "2.1.89", capabilities: [] });
  assert.equal(requests[0]!.url, "/generations/resolve");
});

test("downloadArtifacts fetches the artifact bundle with a bearer token", async (t) => {
  const bundle = {
    packageId: "cipherpol.aegis/agent/task-router",
    version: "1.0.0",
    digest: `sha256:${"b".repeat(64)}`,
    files: [{ path: "task-router.md", contentBase64: Buffer.from("hello").toString("base64"), mode: 420 }],
  };
  const { baseUrl, requests } = await startGateway(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(bundle));
  });
  const result = await authenticated(baseUrl).downloadArtifacts("cipherpol.aegis/agent/task-router", "1.0.0");
  assert.equal(result.packageId, "cipherpol.aegis/agent/task-router");
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]!.contentBase64, Buffer.from("hello").toString("base64"));
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.method, "GET");
  assert.equal(requests[0]!.url, "/registry/artifacts/cipherpol.aegis%2Fagent%2Ftask-router/1.0.0");
  assert.equal(requests[0]!.authorization, `Bearer ${TOKEN}`);
});

test("downloadArtifacts surfaces the server error code and message", async (t) => {
  const { baseUrl } = await startGateway(t, (_request, response) => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "ARTIFACT_NOT_FOUND", message: "No artifacts for cipherpol.aegis/agent/task-router@1.0.0" }));
  });
  await assert.rejects(
    authenticated(baseUrl).downloadArtifacts("cipherpol.aegis/agent/task-router", "1.0.0"),
    (error: unknown) => error instanceof GatewayError
      && error.status === 404
      && error.code === "ARTIFACT_NOT_FOUND"
      && error.message === "No artifacts for cipherpol.aegis/agent/task-router@1.0.0",
  );
});

test("ingest posts the closure payload with a bearer token and returns the snapshot id", async (t) => {
  const { baseUrl, requests } = await startGateway(t, (_request, response) => {
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ snapshotId: "snap-123" }));
  });
  const artifactKey = "cipherpol.aegis/agent/task-router@1.0.0";
  const contentBase64 = Buffer.from("payload").toString("base64");
  const result = await authenticated(baseUrl).ingest({
    registryEnvelope: { keyId: "test-key" },
    admissionEnvelopes: { "admissions/task-router.json": { provenance: {} } },
    channel: "stable",
    artifacts: { [artifactKey]: { "task-router.md": contentBase64 } },
  });
  assert.equal(result.snapshotId, "snap-123");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.method, "POST");
  assert.equal(requests[0]!.url, "/registry/ingest");
  assert.equal(requests[0]!.authorization, `Bearer ${TOKEN}`);
  const payload = JSON.parse(requests[0]!.body) as { channel: string; artifacts: Record<string, Record<string, string>> };
  assert.equal(payload.channel, "stable");
  assert.equal(payload.artifacts[artifactKey]!["task-router.md"], contentBase64);
});
