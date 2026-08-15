import { cipherpolManifestSchema } from "@cipherpol/contracts";
import type { Client } from "@cipherpol/resolver";
import type { SupabaseClient } from "@supabase/supabase-js";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { ControlPlaneError } from "./errors.js";
import { resolveGenerationFromRegistry } from "./generations.js";
import { ingestClosure, type ControlPlaneTrustConfig } from "./ingest.js";
import { getProjectBySlug, listProjects, registerProject } from "./projects.js";
import { assignPolicyProfile, getPolicyProfile, registerPolicyProfile } from "./policy-profiles.js";
import { promoteGeneration } from "./promotion.js";
import { getCurrentSnapshot, getPackage, listPackages } from "./registry-reads.js";
import { getPackageArtifacts } from "./artifact-store.js";
import { listIngestHistory } from "./operations.js";
import { revokeArtifact } from "./revocation.js";
import { verifyGoogleIdToken, type GoogleAuthConfig, type GoogleIdentity } from "./google-auth.js";
import { listReviews, recordReview } from "./reviews.js";
import { listActivations, recordActivation } from "./activations.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the global onRequest auth hook once the caller's Google ID token is verified. */
    googleUser?: GoogleIdentity;
  }
}

const ingestRequestSchema = z.object({
  registryEnvelope: z.unknown(),
  admissionEnvelopes: z.record(z.string(), z.unknown()),
  channel: z.string().min(1),
  artifacts: z.record(z.string(), z.record(z.string(), z.string())).optional(),
}).strict();

const resolveRequestSchema = z.object({
  manifest: cipherpolManifestSchema,
  client: z.object({
    claudeCodeVersion: z.string().min(1),
    capabilities: z.array(z.string()),
  }),
  projectId: z.string().min(1).optional(),
}).strict();

const registerProjectRequestSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  defaultChannel: z.enum(["canary", "stable", "pinned"]),
  platforms: z.array(z.string()),
  owners: z.array(z.string()),
}).strict();

const promoteRequestSchema = z.object({
  fromChannel: z.string().min(1),
  toChannel: z.string().min(1),
}).strict();

const registerPolicyProfileRequestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  allowedPlatforms: z.array(z.string()).optional(),
  allowedCapabilityPacks: z.array(z.string()).optional(),
}).strict();

const assignPolicyProfileRequestSchema = z.object({
  policyProfileId: z.string().min(1).nullable(),
}).strict();

const reviewRequestSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  comment: z.string().optional(),
}).strict();

const recordActivationRequestSchema = z.object({
  projectId: z.string().min(1).optional(),
  channel: z.string().min(1),
  snapshotId: z.string().min(1),
  generationDigest: z.string().min(1),
  claudeCodeVersion: z.string().min(1),
  capabilities: z.array(z.string()).optional(),
}).strict();

const revocationRequestSchema = z.object({
  kind: z.enum(["package", "capabilityPack", "playbook"]),
  id: z.string().min(1),
  version: z.string().min(1),
  action: z.enum(["revoke", "unrevoke"]),
  requestedAt: z.string().min(1),
}).strict();

const revocationEnvelopeSchema = z.object({
  keyId: z.string().min(1),
  keyPurpose: z.enum(["fixture", "production"]),
  signature: z.string().min(1),
  revocation: revocationRequestSchema,
}).strict();

function sendControlPlaneError(app: FastifyInstance, reply: FastifyReply, error: ControlPlaneError, channel?: string): void {
  if (error.code === "INVALID_ENVELOPE" || error.code === "INGEST_CONFLICT") {
    app.log.warn({ code: error.code, channel, message: error.message }, "control-plane rejected request");
  }
  void reply.status(error.httpStatus).send({ code: error.code, message: error.message });
}

function sendNotFound(reply: FastifyReply, message: string): void {
  void reply.status(404).send({ code: "NOT_FOUND", message });
}

function sendUnexpectedError(app: FastifyInstance, reply: FastifyReply, error: unknown): void {
  app.log.error(error);
  void reply.status(500).send({ code: "INTERNAL_ERROR", message: "An unexpected error occurred" });
}

/**
 * Builds (but does not start listening on) the Fastify HTTP API in front of the
 * persisted registry: verifying ingestion, registry reads, and generation
 * resolution. `trust` is the server-pinned root of trust resolved once at boot
 * from `loadControlPlaneEnv` — never per-request — and is the sole source of the
 * key ID/public key/key purpose/fixture-allowance used to verify every ingested
 * envelope. Every `ControlPlaneError` raised by the underlying modules (including
 * `CipherpolError`s from `@cipherpol/resolver`, already remapped by
 * `resolveGenerationFromRegistry`) is mapped to its declared HTTP status and a
 * stable `{ code, message }` body; anything else is logged and reported as a
 * redacted 500.
 *
 * Every route except `/health` and `/health/ready` requires a valid Google ID
 * token (`Authorization: Bearer <token>`) whose `email` either belongs to one
 * of `googleAuth.allowedEmailDomains` or exactly equals one of
 * `googleAuth.allowedEmails` — enforced by a global `onRequest` hook, not
 * per-route, so a new route added later is safe by default rather than
 * accidentally open. `/health`/`/health/ready` are the sole exemptions because
 * they are infrastructure liveness/readiness checks (load balancers, uptime
 * monitors) that cannot perform OAuth and reveal no registry content.
 */
export function buildServer(
  client: SupabaseClient,
  trust: ControlPlaneTrustConfig,
  googleAuth: GoogleAuthConfig,
): FastifyInstance {
  const app = Fastify({ logger: true });

  const PUBLIC_PATHS = new Set(["/health", "/health/ready"]);
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (PUBLIC_PATHS.has(request.routeOptions.url ?? request.url)) return;
    const identity = await verifyGoogleIdToken(googleAuth, request.headers.authorization);
    if (identity === undefined) {
      void reply.status(401).send({ code: "UNAUTHENTICATED", message: "A valid Google account session is required" });
      return;
    }
    request.googleUser = identity;
  });

  app.post("/registry/ingest", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = ingestRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      sendControlPlaneError(
        app,
        reply,
        new ControlPlaneError("INVALID_ENVELOPE", 422, "Malformed ingest request body", { issues: parsed.error.issues }),
      );
      return;
    }
    try {
      const result = await ingestClosure(client, trust, {
        registryEnvelope: parsed.data.registryEnvelope,
        admissionEnvelopes: parsed.data.admissionEnvelopes,
        channel: parsed.data.channel,
        ...(parsed.data.artifacts !== undefined ? { artifacts: parsed.data.artifacts } : {}),
        // Guaranteed defined: the global onRequest hook already rejected any
        // request without a verified Google identity before this handler runs.
        publishedBy: request.googleUser!.email,
      });
      void reply.status(201).send(result);
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        sendControlPlaneError(app, reply, error, parsed.data.channel);
        return;
      }
      sendUnexpectedError(app, reply, error);
    }
  });

  app.get(
    "/registry/packages",
    async (request: FastifyRequest<{ Querystring: { channel?: string } }>, reply: FastifyReply) => {
      const channel = request.query.channel;
      if (channel === undefined || channel.length === 0) {
        sendControlPlaneError(
          app,
          reply,
          new ControlPlaneError("UNKNOWN_CHANNEL", 404, "Query parameter 'channel' is required"),
        );
        return;
      }
      try {
        const packages = await listPackages(client, channel);
        if (packages === undefined) {
          sendControlPlaneError(
            app,
            reply,
            new ControlPlaneError("UNKNOWN_CHANNEL", 404, `No registry snapshot for channel ${channel}`, { channel }),
          );
          return;
        }
        void reply.status(200).send(packages);
      } catch (error) {
        sendUnexpectedError(app, reply, error);
      }
    },
  );

  // Package IDs are themselves multi-segment paths (e.g. "cipherpol-1/adapter/cp1"),
  // so a single named Fastify param cannot capture `:id` without also swallowing
  // `:version`. A wildcard captures the full "<id>/<version>" tail and this handler
  // splits it on the final "/", which is exactly the URL shape a client following
  // "/registry/packages/:id/:version" would request.
  app.get(
    "/registry/packages/*",
    async (request: FastifyRequest<{ Params: { "*": string } }>, reply: FastifyReply) => {
      const tail = request.params["*"];
      const lastSlash = tail.lastIndexOf("/");
      if (lastSlash <= 0 || lastSlash === tail.length - 1) {
        sendControlPlaneError(
          app,
          reply,
          new ControlPlaneError("INVALID_ENVELOPE", 422, "Expected path /registry/packages/<id>/<version>"),
        );
        return;
      }
      const id = tail.slice(0, lastSlash);
      const version = tail.slice(lastSlash + 1);
      try {
        const record = await getPackage(client, id, version);
        if (record === undefined) {
          sendNotFound(reply, `No package ${id}@${version}`);
          return;
        }
        void reply.status(200).send(record);
      } catch (error) {
        sendUnexpectedError(app, reply, error);
      }
    },
  );

  // Serves a package's persisted artifact file bytes for consumer downloads
  // (e.g. `cipherpol setup`). Package IDs contain slashes, so the same
  // wildcard-then-split-on-final-slash shape as `/registry/packages/*` is used
  // to capture "<id>/<version>" where the id is everything before the last `/`.
  app.get(
    "/registry/artifacts/*",
    async (request: FastifyRequest<{ Params: { "*": string } }>, reply: FastifyReply) => {
      const tail = request.params["*"];
      const lastSlash = tail.lastIndexOf("/");
      if (lastSlash <= 0 || lastSlash === tail.length - 1) {
        sendControlPlaneError(
          app,
          reply,
          new ControlPlaneError("INVALID_ENVELOPE", 422, "Expected path /registry/artifacts/<id>/<version>"),
        );
        return;
      }
      const id = tail.slice(0, lastSlash);
      const version = tail.slice(lastSlash + 1);
      try {
        const artifacts = await getPackageArtifacts(client, id, version);
        if (artifacts === undefined) {
          sendNotFound(reply, `No artifacts for package ${id}@${version}`);
          return;
        }
        void reply.status(200).send(artifacts);
      } catch (error) {
        sendUnexpectedError(app, reply, error);
      }
    },
  );


  app.get(
    "/registry/snapshots/:channel",
    async (request: FastifyRequest<{ Params: { channel: string } }>, reply: FastifyReply) => {
      try {
        const snapshot = await getCurrentSnapshot(client, request.params.channel);
        if (snapshot === undefined) {
          sendControlPlaneError(
            app,
            reply,
            new ControlPlaneError(
              "UNKNOWN_CHANNEL", 404, `No registry snapshot for channel ${request.params.channel}`,
              { channel: request.params.channel },
            ),
            request.params.channel,
          );
          return;
        }
        void reply.status(200).send(snapshot);
      } catch (error) {
        sendUnexpectedError(app, reply, error);
      }
    },
  );

  app.post("/generations/resolve", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = resolveRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      sendControlPlaneError(
        app,
        reply,
        new ControlPlaneError("RESOLUTION_FAILED", 422, "Invalid generation resolution request", { issues: parsed.error.issues }),
      );
      return;
    }
    const resolverClient: Client = {
      claudeCodeVersion: parsed.data.client.claudeCodeVersion,
      capabilities: new Set(parsed.data.client.capabilities),
    };
    try {
      const generation = await resolveGenerationFromRegistry(client, parsed.data.manifest, resolverClient, parsed.data.projectId);
      void reply.status(200).send(generation);
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        sendControlPlaneError(app, reply, error);
        return;
      }
      sendUnexpectedError(app, reply, error);
    }
  });

  app.post("/projects", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = registerProjectRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      sendControlPlaneError(
        app,
        reply,
        new ControlPlaneError("INVALID_ENVELOPE", 422, "Malformed project registration request body", { issues: parsed.error.issues }),
      );
      return;
    }
    try {
      const result = await registerProject(client, parsed.data);
      void reply.status(201).send(result);
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        sendControlPlaneError(app, reply, error);
        return;
      }
      sendUnexpectedError(app, reply, error);
    }
  });

  app.get(
    "/projects/:slug",
    async (request: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply) => {
      try {
        const project = await getProjectBySlug(client, request.params.slug);
        if (project === undefined) {
          sendNotFound(reply, `No project with slug ${request.params.slug}`);
          return;
        }
        void reply.status(200).send(project);
      } catch (error) {
        sendUnexpectedError(app, reply, error);
      }
    },
  );

  app.get("/projects", async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const projects = await listProjects(client);
      void reply.status(200).send(projects);
    } catch (error) {
      sendUnexpectedError(app, reply, error);
    }
  });

  app.get("/health", async (_request: FastifyRequest, reply: FastifyReply) => {
    void reply.status(200).send({ status: "ok" });
  });

  app.get("/health/ready", async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { error } = await client.from("projects").select("id", { count: "exact", head: true });
      if (error) {
        void reply.status(503).send({ status: "not_ready" });
        return;
      }
      void reply.status(200).send({ status: "ready" });
    } catch {
      void reply.status(503).send({ status: "not_ready" });
    }
  });

  app.get(
    "/registry/ingest-history",
    async (request: FastifyRequest<{ Querystring: { channel?: string; limit?: string } }>, reply: FastifyReply) => {
      try {
        const channel = request.query.channel;
        const limitRaw = request.query.limit;
        const filters: { channel?: string; limit?: number } = {};
        if (channel !== undefined && channel.length > 0) filters.channel = channel;
        if (limitRaw !== undefined) {
          const limit = Number.parseInt(limitRaw, 10);
          if (!Number.isNaN(limit)) filters.limit = limit;
        }
        const entries = await listIngestHistory(client, filters);
        void reply.status(200).send(entries);
      } catch (error) {
        sendUnexpectedError(app, reply, error);
      }
    },
  );

  app.post("/generations/promote", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = promoteRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      sendControlPlaneError(
        app,
        reply,
        new ControlPlaneError("INVALID_ENVELOPE", 422, "Malformed promotion request body", { issues: parsed.error.issues }),
      );
      return;
    }
    try {
      const result = await promoteGeneration(client, trust, {
        fromChannel: parsed.data.fromChannel,
        toChannel: parsed.data.toChannel,
      });
      void reply.status(200).send(result);
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        sendControlPlaneError(app, reply, error);
        return;
      }
      sendUnexpectedError(app, reply, error);
    }
  });

  app.post("/policy-profiles", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = registerPolicyProfileRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      sendControlPlaneError(
        app,
        reply,
        new ControlPlaneError("INVALID_ENVELOPE", 422, "Malformed policy profile registration request body", { issues: parsed.error.issues }),
      );
      return;
    }
    try {
      const result = await registerPolicyProfile(client, parsed.data);
      void reply.status(201).send(result);
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        sendControlPlaneError(app, reply, error);
        return;
      }
      sendUnexpectedError(app, reply, error);
    }
  });

  app.get(
    "/policy-profiles/:id",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const profile = await getPolicyProfile(client, request.params.id);
        if (profile === undefined) {
          sendNotFound(reply, `No policy profile with id ${request.params.id}`);
          return;
        }
        void reply.status(200).send(profile);
      } catch (error) {
        sendUnexpectedError(app, reply, error);
      }
    },
  );

  app.post(
    "/projects/:id/policy-profile",
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const parsed = assignPolicyProfileRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        sendControlPlaneError(
          app,
          reply,
          new ControlPlaneError("INVALID_ENVELOPE", 422, "Malformed policy profile assignment request body", { issues: parsed.error.issues }),
        );
        return;
      }
      try {
        await assignPolicyProfile(client, request.params.id, parsed.data.policyProfileId);
        void reply.status(200).send({ ok: true });
      } catch (error) {
        if (error instanceof ControlPlaneError) {
          sendControlPlaneError(app, reply, error);
          return;
        }
        sendUnexpectedError(app, reply, error);
      }
    },
  );

  app.post("/activations", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = recordActivationRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      sendControlPlaneError(
        app,
        reply,
        new ControlPlaneError("INVALID_ENVELOPE", 422, "Malformed activation record request body", { issues: parsed.error.issues }),
      );
      return;
    }
    try {
      const result = await recordActivation(client, {
        channel: parsed.data.channel,
        snapshotId: parsed.data.snapshotId,
        generationDigest: parsed.data.generationDigest,
        claudeCodeVersion: parsed.data.claudeCodeVersion,
        ...(parsed.data.projectId !== undefined ? { projectId: parsed.data.projectId } : {}),
        ...(parsed.data.capabilities !== undefined ? { capabilities: parsed.data.capabilities } : {}),
      });
      void reply.status(201).send(result);
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        sendControlPlaneError(app, reply, error);
        return;
      }
      sendUnexpectedError(app, reply, error);
    }
  });

  app.get(
    "/activations",
    async (request: FastifyRequest<{ Querystring: { projectId?: string; channel?: string; limit?: string } }>, reply: FastifyReply) => {
      try {
        const projectId = request.query.projectId;
        const channel = request.query.channel;
        const limitRaw = request.query.limit;
        const filters: { projectId?: string; channel?: string; limit?: number } = {};
        if (projectId !== undefined && projectId.length > 0) filters.projectId = projectId;
        if (channel !== undefined && channel.length > 0) filters.channel = channel;
        if (limitRaw !== undefined) {
          const limit = Number.parseInt(limitRaw, 10);
          if (!Number.isNaN(limit)) filters.limit = limit;
        }
        const activations = await listActivations(client, filters);
        void reply.status(200).send(activations);
      } catch (error) {
        sendUnexpectedError(app, reply, error);
      }
    },
  );


  app.post(
    "/generations/:snapshotId/reviews",
    async (request: FastifyRequest<{ Params: { snapshotId: string } }>, reply: FastifyReply) => {
      const parsed = reviewRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        sendControlPlaneError(
          app,
          reply,
          new ControlPlaneError("INVALID_ENVELOPE", 422, "Malformed review request body", { issues: parsed.error.issues }),
        );
        return;
      }
      try {
        const result = await recordReview(client, {
          snapshotId: request.params.snapshotId,
          // Guaranteed defined: the global onRequest hook already rejected any
          // request without a verified Google identity before this handler runs.
          reviewerEmail: request.googleUser!.email,
          decision: parsed.data.decision,
          ...(parsed.data.comment === undefined ? {} : { comment: parsed.data.comment }),
        });
        void reply.status(201).send(result);
      } catch (error) {
        if (error instanceof ControlPlaneError) {
          sendControlPlaneError(app, reply, error);
          return;
        }
        sendUnexpectedError(app, reply, error);
      }
    },
  );

  app.get(
    "/generations/:snapshotId/reviews",
    async (request: FastifyRequest<{ Params: { snapshotId: string } }>, reply: FastifyReply) => {
      try {
        const reviews = await listReviews(client, request.params.snapshotId);
        void reply.status(200).send(reviews);
      } catch (error) {
        sendUnexpectedError(app, reply, error);
      }
    },
  );

  app.post("/revocations", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = revocationEnvelopeSchema.safeParse(request.body);
    if (!parsed.success) {
      sendControlPlaneError(
        app,
        reply,
        new ControlPlaneError("INVALID_ENVELOPE", 422, "Malformed revocation request body", { issues: parsed.error.issues }),
      );
      return;
    }
    try {
      const result = await revokeArtifact(client, trust, parsed.data);
      if (result === undefined) {
        sendNotFound(
          reply,
          `No ${parsed.data.revocation.kind} ${parsed.data.revocation.id}@${parsed.data.revocation.version}`,
        );
        return;
      }
      void reply.status(200).send(result);
    } catch (error) {
      if (error instanceof ControlPlaneError) {
        sendControlPlaneError(app, reply, error);
        return;
      }
      sendUnexpectedError(app, reply, error);
    }
  });


  return app;
}
