-- 0003_vector_only_search.sql
-- Simplify search_chunks to pure vector ANN (drops FTS/RRF arm) and remove
-- the fts stored column + GIN index to reclaim ~100–300 MB of storage.
-- p_query_text / p_rrf_k are kept in the signature for backwards compatibility
-- but are no longer used.

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

-- Drop GIN FTS index (immediate large space reclaim)
DROP INDEX IF EXISTS chunks_fts_gin;

-- Drop stored tsvector column (space reclaimed after VACUUM)
ALTER TABLE chunks DROP COLUMN IF EXISTS fts;
