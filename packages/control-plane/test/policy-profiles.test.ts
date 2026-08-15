import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assignPolicyProfile,
  buildServer,
  ControlPlaneError,
  getPolicyProfile,
  registerPolicyProfile,
  registerProject,
} from "../src/index.js";
import type { ControlPlaneTrustConfig, ProjectRecord, RegisterPolicyProfileInput } from "../src/index.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  test.skip("policy-profiles.test.ts requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (skipping — no live Supabase instance configured)", () => {});
} else {
  const client: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // `/policy-profiles` and the assignment route never touch trust keys, so any
  // trust config works for `buildServer` (mirrors projects.test.ts).
  const trust: ControlPlaneTrustConfig = {
    trustedKeyId: "unused",
    trustedPublicKeyPem: "unused",
    trustedKeyPurpose: "fixture",
    allowFixtureKeys: true,
  };

  function uniqueSuffix(): string {
    return randomBytes(4).toString("hex");
  }

  function uniqueProfileId(): string {
    return `policy-profiles-test-${uniqueSuffix()}`;
  }

  function uniqueProjectId(): string {
    return `policy-profiles-project-${uniqueSuffix()}`;
  }

  function projectInput(id: string, suffix: string): Omit<ProjectRecord, "registeredAt"> {
    return {
      id,
      slug: `policy-profiles-slug-${suffix}`,
      name: `Policy Profile Project ${suffix}`,
      defaultChannel: "stable",
      platforms: ["flutter"],
      owners: ["control-plane-test"],
    };
  }

  function profileInput(
    id: string,
    suffix: string,
    overrides: Partial<RegisterPolicyProfileInput> = {},
  ): RegisterPolicyProfileInput {
    return {
      id,
      name: `Policy Profile ${suffix}`,
      allowedPlatforms: ["flutter", "web-nextjs"],
      allowedCapabilityPacks: [`cipherpol-test-${suffix}/pack/dev`],
      ...overrides,
    };
  }

  // Delete order matters: a project references its policy profile via
  // `projects.policy_profile_id`, so projects must be removed before the profiles
  // they reference.
  async function cleanupRows(ids: { readonly projects?: readonly string[]; readonly profiles?: readonly string[] }): Promise<void> {
    for (const id of ids.projects ?? []) {
      const { error } = await client.from("projects").delete().eq("id", id);
      if (error) throw error;
    }
    for (const id of ids.profiles ?? []) {
      const { error } = await client.from("policy_profiles").delete().eq("id", id);
      if (error) throw error;
    }
  }

  test("registerPolicyProfile persists the row and returns its id", async (t) => {
    const suffix = uniqueSuffix();
    const id = uniqueProfileId();
    t.after(() => cleanupRows({ profiles: [id] }));

    const result = await registerPolicyProfile(client, profileInput(id, suffix));
    assert.equal(result.id, id);

    const { data: row, error } = await client.from("policy_profiles").select("id, name").eq("id", id).single();
    assert.equal(error, null);
    assert.equal(row?.id, id);
    assert.equal(row?.name, `Policy Profile ${suffix}`);
  });

  test("re-registering an identical profile is a no-op", async (t) => {
    const suffix = uniqueSuffix();
    const id = uniqueProfileId();
    t.after(() => cleanupRows({ profiles: [id] }));

    const input = profileInput(id, suffix);
    const first = await registerPolicyProfile(client, input);
    const second = await registerPolicyProfile(client, input);
    assert.equal(second.id, first.id);

    const { data: rows } = await client.from("policy_profiles").select("id").eq("id", id);
    assert.equal(rows?.length, 1);
  });

  test("re-registering a differing profile is rejected with POLICY_PROFILE_CONFLICT", async (t) => {
    const suffix = uniqueSuffix();
    const id = uniqueProfileId();
    t.after(() => cleanupRows({ profiles: [id] }));

    await registerPolicyProfile(client, profileInput(id, suffix));

    await assert.rejects(
      () => registerPolicyProfile(client, { ...profileInput(id, suffix), name: "A different name" }),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "POLICY_PROFILE_CONFLICT" && error.httpStatus === 409,
    );

    const { data: row } = await client.from("policy_profiles").select("name").eq("id", id).single();
    assert.equal(row?.name, `Policy Profile ${suffix}`);
  });

  test("getPolicyProfile returns the record for a known id and undefined for an unknown id", async (t) => {
    const suffix = uniqueSuffix();
    const id = uniqueProfileId();
    t.after(() => cleanupRows({ profiles: [id] }));

    await registerPolicyProfile(client, profileInput(id, suffix));

    const record = await getPolicyProfile(client, id);
    assert.ok(record);
    assert.equal(record.id, id);
    assert.deepEqual(record.allowedPlatforms, ["flutter", "web-nextjs"]);
    assert.deepEqual(record.allowedCapabilityPacks, [`cipherpol-test-${suffix}/pack/dev`]);
    assert.ok(record.createdAt.length > 0);

    const missing = await getPolicyProfile(client, `policy-profiles-unknown-${uniqueSuffix()}`);
    assert.equal(missing, undefined);
  });

  test("omitting allowedPlatforms/allowedCapabilityPacks stores null (unrestricted), not an empty array", async (t) => {
    const suffix = uniqueSuffix();
    const id = uniqueProfileId();
    t.after(() => cleanupRows({ profiles: [id] }));

    await registerPolicyProfile(client, { id, name: `Unrestricted ${suffix}` });

    const record = await getPolicyProfile(client, id);
    assert.ok(record);
    assert.equal(record.allowedPlatforms, null);
    assert.equal(record.allowedCapabilityPacks, null);
  });

  test("assignPolicyProfile sets projects.policy_profile_id and clearing with null removes it", async (t) => {
    const suffix = uniqueSuffix();
    const projectId = uniqueProjectId();
    const profileId = uniqueProfileId();
    t.after(() => cleanupRows({ projects: [projectId], profiles: [profileId] }));

    await registerProject(client, projectInput(projectId, suffix));
    await registerPolicyProfile(client, profileInput(profileId, suffix));

    await assignPolicyProfile(client, projectId, profileId);
    const { data: assigned } = await client
      .from("projects")
      .select("policy_profile_id")
      .eq("id", projectId)
      .single();
    assert.equal(assigned?.policy_profile_id, profileId);

    await assignPolicyProfile(client, projectId, null);
    const { data: cleared } = await client
      .from("projects")
      .select("policy_profile_id")
      .eq("id", projectId)
      .single();
    assert.equal(cleared?.policy_profile_id, null);
  });

  test("assignPolicyProfile to an unknown project is a clean 404 UNKNOWN_PROJECT", async (t) => {
    const suffix = uniqueSuffix();
    const profileId = uniqueProfileId();
    t.after(() => cleanupRows({ profiles: [profileId] }));

    await registerPolicyProfile(client, profileInput(profileId, suffix));

    await assert.rejects(
      () => assignPolicyProfile(client, `policy-profiles-unknown-project-${uniqueSuffix()}`, profileId),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "UNKNOWN_PROJECT" && error.httpStatus === 404,
    );
  });

  test("assignPolicyProfile to an unknown profile is a clean 404 UNKNOWN_POLICY_PROFILE", async (t) => {
    const suffix = uniqueSuffix();
    const projectId = uniqueProjectId();
    t.after(() => cleanupRows({ projects: [projectId] }));

    await registerProject(client, projectInput(projectId, suffix));

    await assert.rejects(
      () => assignPolicyProfile(client, projectId, `policy-profiles-unknown-profile-${uniqueSuffix()}`),
      (error: unknown) =>
        error instanceof ControlPlaneError && error.code === "UNKNOWN_POLICY_PROFILE" && error.httpStatus === 404,
    );
  });

  test("POST /policy-profiles registers a profile over HTTP and returns 201", async (t) => {
    const suffix = uniqueSuffix();
    const id = uniqueProfileId();
    t.after(() => cleanupRows({ profiles: [id] }));
    const app = buildServer(client, trust);
    t.after(() => app.close());

    const response = await app.inject({ method: "POST", url: "/policy-profiles", payload: profileInput(id, suffix) });
    assert.equal(response.statusCode, 201);
    const body = response.json() as { id: string };
    assert.equal(body.id, id);
  });

  test("POST /policy-profiles returns 409 POLICY_PROFILE_CONFLICT for conflicting re-registration", async (t) => {
    const suffix = uniqueSuffix();
    const id = uniqueProfileId();
    t.after(() => cleanupRows({ profiles: [id] }));
    const app = buildServer(client, trust);
    t.after(() => app.close());

    const first = await app.inject({ method: "POST", url: "/policy-profiles", payload: profileInput(id, suffix) });
    assert.equal(first.statusCode, 201);

    const second = await app.inject({
      method: "POST",
      url: "/policy-profiles",
      payload: { ...profileInput(id, suffix), name: "A different name" },
    });
    assert.equal(second.statusCode, 409);
    const body = second.json() as { code: string };
    assert.equal(body.code, "POLICY_PROFILE_CONFLICT");
  });

  test("GET /policy-profiles/:id returns the profile and 404 for an unknown id", async (t) => {
    const suffix = uniqueSuffix();
    const id = uniqueProfileId();
    t.after(() => cleanupRows({ profiles: [id] }));
    const app = buildServer(client, trust);
    t.after(() => app.close());

    const registerResponse = await app.inject({ method: "POST", url: "/policy-profiles", payload: profileInput(id, suffix) });
    assert.equal(registerResponse.statusCode, 201);

    const found = await app.inject({ method: "GET", url: `/policy-profiles/${id}` });
    assert.equal(found.statusCode, 200);
    const foundBody = found.json() as { id: string; name: string };
    assert.equal(foundBody.id, id);
    assert.equal(foundBody.name, `Policy Profile ${suffix}`);

    const notFound = await app.inject({ method: "GET", url: `/policy-profiles/policy-profiles-unknown-${uniqueSuffix()}` });
    assert.equal(notFound.statusCode, 404);
  });

  test("POST /projects/:id/policy-profile assigns over HTTP and returns an ack", async (t) => {
    const suffix = uniqueSuffix();
    const projectId = uniqueProjectId();
    const profileId = uniqueProfileId();
    t.after(() => cleanupRows({ projects: [projectId], profiles: [profileId] }));
    const app = buildServer(client, trust);
    t.after(() => app.close());

    await registerProject(client, projectInput(projectId, suffix));
    await registerPolicyProfile(client, profileInput(profileId, suffix));

    const response = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/policy-profile`,
      payload: { policyProfileId: profileId },
    });
    assert.equal(response.statusCode, 200);

    const { data: row } = await client.from("projects").select("policy_profile_id").eq("id", projectId).single();
    assert.equal(row?.policy_profile_id, profileId);
  });

  test("POST /projects/:id/policy-profile returns clean 404s for unknown project and unknown profile", async (t) => {
    const suffix = uniqueSuffix();
    const projectId = uniqueProjectId();
    const profileId = uniqueProfileId();
    t.after(() => cleanupRows({ projects: [projectId], profiles: [profileId] }));
    const app = buildServer(client, trust);
    t.after(() => app.close());

    await registerProject(client, projectInput(projectId, suffix));
    await registerPolicyProfile(client, profileInput(profileId, suffix));

    const unknownProject = await app.inject({
      method: "POST",
      url: `/projects/policy-profiles-unknown-project-${uniqueSuffix()}/policy-profile`,
      payload: { policyProfileId: profileId },
    });
    assert.equal(unknownProject.statusCode, 404);
    const unknownProjectBody = unknownProject.json() as { code: string };
    assert.equal(unknownProjectBody.code, "UNKNOWN_PROJECT");

    const unknownProfile = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/policy-profile`,
      payload: { policyProfileId: `policy-profiles-unknown-profile-${uniqueSuffix()}` },
    });
    assert.equal(unknownProfile.statusCode, 404);
    const unknownProfileBody = unknownProfile.json() as { code: string };
    assert.equal(unknownProfileBody.code, "UNKNOWN_POLICY_PROFILE");
  });
}
