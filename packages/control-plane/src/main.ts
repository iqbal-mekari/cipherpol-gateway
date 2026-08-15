import { createClient } from "@supabase/supabase-js";
import { loadControlPlaneEnv } from "./env.js";
import type { ControlPlaneTrustConfig } from "./ingest.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const env = loadControlPlaneEnv(process.env);
  const client = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const trust: ControlPlaneTrustConfig = {
    trustedKeyId: env.trustedKeyId,
    trustedPublicKeyPem: env.trustedPublicKeyPem,
    trustedKeyPurpose: env.trustedKeyPurpose,
    allowFixtureKeys: env.allowFixtureKeys,
  };
  const app = buildServer(client, trust, {
    allowedEmailDomains: env.googleAuthAllowedEmailDomains,
    allowedEmails: env.googleAuthAllowedEmails,
  });
  await app.listen({ port: env.port, host: "0.0.0.0" });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
