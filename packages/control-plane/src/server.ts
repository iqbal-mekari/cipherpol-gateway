import { cipherpolManifestSchema } from "@cipherpol/contracts";
import type { Client } from "@cipherpol/resolver";
import type { SupabaseClient } from "@supabase/supabase-js";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { ControlPlaneError } from "./errors.js";
import { resolveGenerationFromRegistry } from "./generations.js";
import { ingestClosure, type ControlPlaneTrustConfig } from "./ingest.js";
import { getProjectBySlug, listProjects, registerProject } from "./projects.js";
import { getCurrentSnapshot, getPackage, listPackages } from "./registry-reads.js";

const ingestRequestSchema = z.object({
  registryEnvelope: z.unknown(),
  admissionEnvelopes: z.record(z.string(), z.unknown()),
  channel: z.string().min(1),
}).strict();

const resolveRequestSchema = z.object({
  manifest: cipherpolManifestSchema,
  client: z.object({
    claudeCodeVersion: z.string().min(1),
    capabilities: z.array(z.string()),
  }),
});

const registerProjectRequestSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  defaultChannel: z.enum(["canary", "stable", "pinned"]),
  platforms: z.array(z.string()),
  owners: z.array(z.string()),
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
 */
export function buildServer(client: SupabaseClient, trust: ControlPlaneTrustConfig): FastifyInstance {
  const app = Fastify({ logger: true });

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
      const generation = await resolveGenerationFromRegistry(client, parsed.data.manifest, resolverClient);
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

  return app;
}
