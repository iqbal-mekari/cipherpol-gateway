import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildServer, ControlPlaneError, getProjectBySlug, listProjects, registerProject } from "../src/index.js";
import type { ControlPlaneTrustConfig, ProjectRecord } from "../src/index.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  test.skip("projects.test.ts requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (skipping — no live Supabase instance configured)", () => {});
} else {
  const client: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // No signed envelopes involved in this slice — `/projects` uses the same
  // unauthenticated-but-content-verified-nowhere-needed boundary as reads, so any
  // trust config works for `buildServer`. These fields are never read by the
  // project routes.
  const trust: ControlPlaneTrustConfig = {
    trustedKeyId: "unused",
    trustedPublicKeyPem: "unused",
    trustedKeyPurpose: "fixture",
    allowFixtureKeys: true,
  };

  function uniqueSuffix(): string {
    return randomBytes(4).toString("hex");
  }

  function uniqueProjectId(): string {
    return `projects-test-${uniqueSuffix()}`;
  }

  async function cleanupProjectIds(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const { error } = await client.from("projects").delete().in("id", ids);
    if (error) throw error;
  }

  function projectInput(id: string, suffix: string): Omit<ProjectRecord, "registeredAt"> {
    return {
      id,
      slug: `slug-${suffix}`,
      name: `Project ${suffix}`,
      defaultChannel: "stable",
      platforms: ["darwin-arm64", "linux-x64"],
      owners: ["control-plane-test"],
    };
  }

  test("registerProject succeeds and returns the id", async (t) => {
    const suffix = uniqueSuffix();
    const id = uniqueProjectId();
    t.after(() => cleanupProjectIds([id]));

    const result = await registerProject(client, projectInput(id, suffix));
    assert.equal(result.id, id);

    const { data: row, error } = await client.from("projects").select("id, slug, name").eq("id", id).single();
    assert.equal(error, null);
    assert.equal(row?.id, id);
    assert.equal(row?.slug, `slug-${suffix}`);
  });

  test("re-registering an identical id with identical content is a no-op", async (t) => {
    const suffix = uniqueSuffix();
    const id = uniqueProjectId();
    t.after(() => cleanupProjectIds([id]));

    const input = projectInput(id, suffix);
    const first = await registerProject(client, input);
    const second = await registerProject(client, input);
    assert.equal(second.id, first.id);

    const { data: rows } = await client.from("projects").select("id").eq("id", id);
    assert.equal(rows?.length, 1);
  });

  const conflictCases: ReadonlyArray<{
    readonly label: string;
    readonly mutate: (input: Omit<ProjectRecord, "registeredAt">) => Omit<ProjectRecord, "registeredAt">;
  }> = [
    { label: "name", mutate: (input) => ({ ...input, name: "A different name" }) },
    { label: "slug", mutate: (input) => ({ ...input, slug: `${input.slug}-changed` }) },
    { label: "defaultChannel", mutate: (input) => ({ ...input, defaultChannel: "canary" }) },
    { label: "platforms", mutate: (input) => ({ ...input, platforms: [...input.platforms, "windows-x64"] }) },
    { label: "owners", mutate: (input) => ({ ...input, owners: [...input.owners, "extra-owner"] }) },
    { label: "platforms order", mutate: (input) => ({ ...input, platforms: [...input.platforms].reverse() }) },
  ];

  for (const { label, mutate } of conflictCases) {
    test(`re-registering with a differing ${label} is rejected with PROJECT_CONFLICT`, async (t) => {
      const suffix = uniqueSuffix();
      const id = uniqueProjectId();
      t.after(() => cleanupProjectIds([id]));

      const input = projectInput(id, suffix);
      await registerProject(client, input);

      await assert.rejects(
        () => registerProject(client, mutate(input)),
        (error: unknown) => error instanceof ControlPlaneError && error.code === "PROJECT_CONFLICT" && error.httpStatus === 409,
      );

      const { data: row } = await client.from("projects").select("name").eq("id", id).single();
      assert.equal(row?.name, `Project ${suffix}`);
    });
  }

  test("registering a new id whose slug collides with a different existing project is rejected with PROJECT_CONFLICT", async (t) => {
    const suffixA = uniqueSuffix();
    const idA = uniqueProjectId();
    const suffixB = uniqueSuffix();
    const idB = uniqueProjectId();
    t.after(() => cleanupProjectIds([idA, idB]));

    await registerProject(client, projectInput(idA, suffixA));

    await assert.rejects(
      () => registerProject(client, { ...projectInput(idB, suffixB), slug: `slug-${suffixA}` }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === "PROJECT_CONFLICT" && error.httpStatus === 409,
    );

    const { data: rows } = await client.from("projects").select("id").eq("id", idB);
    assert.equal(rows?.length, 0);
  });

  test("getProjectBySlug returns the record for a known slug and undefined for an unknown slug", async (t) => {
    const suffix = uniqueSuffix();
    const id = uniqueProjectId();
    t.after(() => cleanupProjectIds([id]));

    await registerProject(client, projectInput(id, suffix));

    const record = await getProjectBySlug(client, `slug-${suffix}`);
    assert.ok(record);
    assert.equal(record.id, id);
    assert.equal(record.defaultChannel, "stable");
    assert.deepEqual(record.platforms, ["darwin-arm64", "linux-x64"]);
    assert.deepEqual(record.owners, ["control-plane-test"]);
    assert.ok(record.registeredAt.length > 0);

    const missing = await getProjectBySlug(client, `slug-unknown-${uniqueSuffix()}`);
    assert.equal(missing, undefined);
  });

  test("listProjects includes registered projects", async (t) => {
    const suffix = uniqueSuffix();
    const id = uniqueProjectId();
    t.after(() => cleanupProjectIds([id]));

    await registerProject(client, projectInput(id, suffix));

    const projects = await listProjects(client);
    assert.ok(projects.some((project) => project.id === id));
  });

  test("POST /projects registers a project over HTTP and returns 201", async (t) => {
    const suffix = uniqueSuffix();
    const id = uniqueProjectId();
    t.after(() => cleanupProjectIds([id]));
    const app = buildServer(client, trust);
    t.after(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/projects",
      payload: projectInput(id, suffix),
    });
    assert.equal(response.statusCode, 201);
    const body = response.json() as { id: string };
    assert.equal(body.id, id);
  });

  test("POST /projects returns 409 PROJECT_CONFLICT for conflicting re-registration over HTTP", async (t) => {
    const suffix = uniqueSuffix();
    const id = uniqueProjectId();
    t.after(() => cleanupProjectIds([id]));
    const app = buildServer(client, trust);
    t.after(() => app.close());

    const first = await app.inject({ method: "POST", url: "/projects", payload: projectInput(id, suffix) });
    assert.equal(first.statusCode, 201);

    const second = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { ...projectInput(id, suffix), name: "A different name" },
    });
    assert.equal(second.statusCode, 409);
    const body = second.json() as { code: string };
    assert.equal(body.code, "PROJECT_CONFLICT");
  });

  test("GET /projects/:slug returns the project over HTTP and 404 for an unknown slug", async (t) => {
    const suffix = uniqueSuffix();
    const id = uniqueProjectId();
    t.after(() => cleanupProjectIds([id]));
    const app = buildServer(client, trust);
    t.after(() => app.close());

    const registerResponse = await app.inject({ method: "POST", url: "/projects", payload: projectInput(id, suffix) });
    assert.equal(registerResponse.statusCode, 201);

    const found = await app.inject({ method: "GET", url: `/projects/slug-${suffix}` });
    assert.equal(found.statusCode, 200);
    const foundBody = found.json() as { id: string; slug: string };
    assert.equal(foundBody.id, id);
    assert.equal(foundBody.slug, `slug-${suffix}`);

    const notFound = await app.inject({ method: "GET", url: `/projects/slug-unknown-${uniqueSuffix()}` });
    assert.equal(notFound.statusCode, 404);
  });

  test("GET /projects returns the full list over HTTP, including a newly registered project", async (t) => {
    const suffix = uniqueSuffix();
    const id = uniqueProjectId();
    t.after(() => cleanupProjectIds([id]));
    const app = buildServer(client, trust);
    t.after(() => app.close());

    const registerResponse = await app.inject({ method: "POST", url: "/projects", payload: projectInput(id, suffix) });
    assert.equal(registerResponse.statusCode, 201);

    const response = await app.inject({ method: "GET", url: "/projects" });
    assert.equal(response.statusCode, 200);
    const projects = response.json() as Array<{ id: string }>;
    assert.ok(Array.isArray(projects));
    assert.ok(projects.some((project) => project.id === id));
  });
}
