-- 0004_hnsw_iterative_scan.sql
-- Fix filtered-ANN recall in search_chunks.
--
-- The vector arm orders by embedding distance and lets Postgres use the HNSW
-- index, but HNSW returns the global top-ef_search candidates BEFORE the
-- project/ref WHERE filter applies. Once several similar projects/refs share
-- the index, a ref's rows can be entirely absent from that global pool and a
-- fully-indexed project returns 0 hits (observed: mobile-talenta@branch:develop
-- returned nothing at ef_search=100 while ef_search=400 found correct results).
--
-- pgvector >= 0.8 solves this properly with iterative index scans: when the
-- filter discards candidates, the scan resumes and fetches more until LIMIT is
-- satisfied (bounded by hnsw.max_scan_tuples, default 20k). relaxed_order
-- allows slightly out-of-order results for better throughput; callers sort by
-- score anyway.
--
-- Requires pgvector >= 0.8 (Supabase ships 0.8+; schema header already assumes it).

create or replace function search_chunks(
  p_project          uuid,
  p_ref              text,
  p_query_embedding  vector(384),
  p_query_text       text,
  p_languages        text[] default null,
  p_path_prefix      text   default null,
  p_kinds            text[] default null,
  p_k                int    default 20,
  p_rrf_k            int    default 60,
  p_pool             int    default 100,
  p_ef_search        int    default 100
)
returns table (
  chunk_id    uuid,
  symbol_id   uuid,
  file_path   text,
  fqn         text,
  language    text,
  symbol_kind text,
  line_range  jsonb,
  content     text,
  score       real
)
language plpgsql
stable
as $$
begin
  perform set_config('hnsw.ef_search', p_ef_search::text, true);
  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);

  return query
  select c.id,
         c.symbol_id,
         c.metadata->>'file_path',
         c.metadata->>'fqn',
         c.metadata->>'language',
         c.metadata->>'symbol_kind',
         c.metadata->'line_range',
         c.content,
         (1 - (c.embedding <=> p_query_embedding))::real as score
  from chunks c
  where c.project_id = p_project
    and c.ref = p_ref
    and c.embedding is not null
    and (p_languages   is null or c.metadata->>'language'    = any(p_languages))
    and (p_kinds       is null or c.metadata->>'symbol_kind' = any(p_kinds))
    and (p_path_prefix is null or c.metadata->>'file_path' like p_path_prefix || '%')
  order by c.embedding <=> p_query_embedding
  limit p_k;
end;
$$;
