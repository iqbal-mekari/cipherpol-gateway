import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "@kb/core";
import ws from "ws";

// supabase-js instantiates a realtime client on construction, which needs a
// global WebSocket. Node < 22 has none — polyfill it (we don't use realtime).
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = ws;
}

let _client: SupabaseClient | null = null;

/**
 * Server-side Supabase client using the SERVICE-ROLE key (RLS-bypassing).
 * MUST only ever run server-side — never ship this key to a client.
 * Singleton so we reuse one pooled connection across the process.
 */
export function db(): SupabaseClient {
  if (_client) return _client;
  _client = createClient(config.supabase.url(), config.supabase.serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}
