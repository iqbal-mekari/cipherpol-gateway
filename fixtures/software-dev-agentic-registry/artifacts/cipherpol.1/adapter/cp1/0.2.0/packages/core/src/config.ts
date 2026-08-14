/**
 * Central environment/config loader. Fails fast with a clear message when a
 * required secret is missing, so misconfiguration surfaces at startup rather
 * than mid-pipeline.
 *
 * NOTE: there are no external AI service keys. Embeddings run locally
 * (Transformers.js) and memory distillation is done by the host (Claude Code)
 * via MCP tools + a skill — neither needs an API key here.
 */

import './loadenv.js'; // populate process.env from the repo-root .env on first use

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  supabase: {
    url: () => required('SUPABASE_URL'),
    serviceRoleKey: () => required('SUPABASE_SERVICE_ROLE_KEY'),
    directDbUrl: () => process.env.SUPABASE_DIRECT_DB_URL,
  },
  /** Local embedding model (Transformers.js). Downloads once, then runs offline.
   *  Default all-MiniLM-L6-v2 (384-dim): ~5-6x faster than jina-base on CPU, which
   *  matters for large repos. Set KB_EMBEDDING_MODEL/DIM to switch (e.g. jina 768),
   *  but the pgvector column dim MUST match — see supabase/migrations/0003_dim_384.sql. */
  embeddings: {
    model: optional('KB_EMBEDDING_MODEL', 'Xenova/all-MiniLM-L6-v2'),
    dimensions: Number(optional('KB_EMBEDDING_DIM', '384')),
  },
  projectsRoot: () => optional('KB_PROJECTS_ROOT', './projects'),
  defaultRef: () => optional('KB_DEFAULT_REF', 'branch:develop'),
} as const;
