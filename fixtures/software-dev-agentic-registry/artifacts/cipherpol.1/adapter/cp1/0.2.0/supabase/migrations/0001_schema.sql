-- ============================================================================
-- 0001_schema.sql — GraphRAG code knowledge graph + memory silo
-- ----------------------------------------------------------------------------
-- Embeddings are produced LOCALLY (Transformers.js, default
-- Xenova/all-MiniLM-L6-v2, 384-dim). No external embedding service.
--   * The vector dimension is fixed at DDL time. If you change KB_EMBEDDING_DIM
--     you must change vector(384) here to match and re-embed.
--   * 384 is well under the pgvector HNSW indexable limit (2000).
--
-- A "ref" scopes a knowledge snapshot of a project (branch:main, tag:v1.2,
-- user:label). The same project is indexed at many refs that coexist here and
-- are searched independently. Code tables (files/symbols/edges/chunks) are
-- ref-scoped; memories (session-scoped) and skills (project-level) are not.
--
-- HNSW indexes are declared here but should be BUILT AFTER bulk load on the
-- direct (5432) connection to avoid OOM / slow row-by-row builds.
-- ============================================================================

create extension if not exists vector;       -- pgvector >= 0.7 (Supabase ships 0.8+)
create extension if not exists pg_trgm;
create extension if not exists "uuid-ossp";

-- ----------------------------------------------------------------------------
-- projects
-- ----------------------------------------------------------------------------
create table if not exists projects (
  id                  uuid primary key default uuid_generate_v4(),
  slug                text not null unique,
  name                text not null,
  repo_url            text,
  default_branch      text not null default 'main',
  embedding_model     text not null default 'Xenova/all-MiniLM-L6-v2',
  embedding_dim       int  not null default 384,
  readme              text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- files (ref-scoped)
-- ----------------------------------------------------------------------------
create table if not exists files (
  id                  uuid primary key default uuid_generate_v4(),
  project_id          uuid not null references projects(id) on delete cascade,
  ref                 text not null,                      -- "branch:main" | "tag:v1.2" | "user:label"
  path                text not null,
  language            text not null,
  content_hash        text not null,
  last_indexed_commit text,
  loc                 int,
  size_bytes          int,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (project_id, ref, path)
);
create index if not exists files_project_ref_idx on files(project_id, ref);
create index if not exists files_lang_idx         on files(project_id, ref, language);
create index if not exists files_path_trgm        on files using gin (path gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- symbols (graph nodes, ref-scoped)
-- ----------------------------------------------------------------------------
create table if not exists symbols (
  id           uuid primary key default uuid_generate_v4(),
  project_id   uuid not null references projects(id) on delete cascade,
  ref          text not null,
  file_id      uuid not null references files(id)    on delete cascade,
  fqn          text not null,
  name         text not null,
  kind         text not null,
  signature    text,
  start_line   int not null,                              -- line range is MUTABLE metadata
  end_line     int not null,
  start_byte   int,
  end_byte     int,
  content_hash text not null,                             -- sha256 of source slice
  doc_comment  text,
  source_text  text,                                       -- verbatim slice (get_symbol / impact)
  is_exported  boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (project_id, ref, fqn, start_line)
);
create index if not exists symbols_file_idx       on symbols(file_id);
create index if not exists symbols_project_ref_idx on symbols(project_id, ref);
create index if not exists symbols_fqn_idx         on symbols(project_id, ref, fqn);
create index if not exists symbols_kind_idx        on symbols(project_id, ref, kind);
create index if not exists symbols_fqn_trgm        on symbols using gin (fqn gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- edges (relationships, ref-scoped)
-- ----------------------------------------------------------------------------
create table if not exists edges (
  id            uuid primary key default uuid_generate_v4(),
  project_id    uuid not null references projects(id) on delete cascade,
  ref           text not null,
  src_symbol_id uuid not null references symbols(id) on delete cascade,
  dst_symbol_id uuid references symbols(id) on delete cascade,
  dst_fqn       text,
  kind          text not null,                            -- calls|imports|extends|implements|references|returns
  src_file_id   uuid not null references files(id) on delete cascade,
  created_at    timestamptz not null default now()
);
create index if not exists edges_src_idx     on edges(src_symbol_id, kind);
create index if not exists edges_dst_idx     on edges(dst_symbol_id, kind);
create index if not exists edges_ref_idx     on edges(project_id, ref);
create index if not exists edges_dstfqn_idx  on edges(project_id, ref, dst_fqn) where dst_symbol_id is null;
create index if not exists edges_srcfile_idx on edges(src_file_id);
create unique index if not exists edges_uniq on edges(src_symbol_id, dst_symbol_id, kind)
  where dst_symbol_id is not null;

-- ----------------------------------------------------------------------------
-- chunks (embedding unit + full-text + metadata, ref-scoped)
-- ----------------------------------------------------------------------------
create table if not exists chunks (
  id           uuid primary key default uuid_generate_v4(),
  project_id   uuid not null references projects(id) on delete cascade,
  ref          text not null,
  file_id      uuid not null references files(id)    on delete cascade,
  symbol_id    uuid references symbols(id) on delete cascade,
  chunk_index  int not null default 0,
  content      text not null,
  content_hash text not null,                             -- sha256(content) -> embedding cache key (ref-independent)
  embedding    vector(384),                               -- null until embedded (FTS still works)
  metadata     jsonb not null default '{}',
  fts          tsvector generated always as (to_tsvector('english', coalesce(content,''))) stored,
  created_at   timestamptz not null default now(),
  unique (symbol_id, chunk_index)
);
create index if not exists chunks_project_ref_idx on chunks(project_id, ref);
create index if not exists chunks_file_idx        on chunks(file_id);
create index if not exists chunks_symbol_idx      on chunks(symbol_id);
create index if not exists chunks_hash_idx        on chunks(content_hash);   -- embedding cache (across refs)
create index if not exists chunks_fts_gin         on chunks using gin (fts);
create index if not exists chunks_meta_gin        on chunks using gin (metadata jsonb_path_ops);

-- ----------------------------------------------------------------------------
-- memories (per-session silo; distilled by the HOST, then stored here)
-- ----------------------------------------------------------------------------
create table if not exists memories (
  id              uuid primary key default uuid_generate_v4(),
  project_id      uuid not null references projects(id) on delete cascade,
  session_id      text not null,
  kind            text not null check (kind in ('decision','fact','pattern','todo','gotcha')),
  title           text,
  content         text not null,
  source_log_path text,
  embedding       vector(384),
  metadata        jsonb not null default '{}',
  fts             tsvector generated always as
                    (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))) stored,
  confidence      real not null default 0.5,
  superseded_by   uuid references memories(id) on delete set null,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz not null default now()
);
create index if not exists memories_project_idx on memories(project_id);
create index if not exists memories_session_idx on memories(project_id, session_id);
create index if not exists memories_kind_idx    on memories(project_id, kind);
create index if not exists memories_fts_gin     on memories using gin (fts);
create index if not exists memories_meta_gin    on memories using gin (metadata jsonb_path_ops);

-- ----------------------------------------------------------------------------
-- skills (patterns / references for a codebase, project-level)
-- ----------------------------------------------------------------------------
create table if not exists skills (
  id           uuid primary key default uuid_generate_v4(),
  project_id   uuid not null references projects(id) on delete cascade,
  slug         text not null,
  title        text not null,
  content      text not null,
  content_hash text not null,
  embedding    vector(384),
  metadata     jsonb not null default '{}',
  fts          tsvector generated always as
                 (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,''))) stored,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (project_id, slug)
);
create index if not exists skills_project_idx on skills(project_id);
create index if not exists skills_fts_gin     on skills using gin (fts);

-- ============================================================================
-- HNSW vector indexes — BUILD AFTER BULK LOAD, ONCE, on the direct connection.
--   set maintenance_work_mem = '512MB';
-- ============================================================================
create index if not exists chunks_embed_hnsw   on chunks   using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index if not exists memories_embed_hnsw on memories using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index if not exists skills_embed_hnsw   on skills   using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
