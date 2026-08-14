-- ============================================================================
-- reset-and-recreate.sql — RUN THIS IN THE SUPABASE SQL EDITOR (one paste)
-- Wipes all data, sets embeddings to vector(384), drops+recreates all RPCs.
-- ============================================================================

begin;

truncate table
  chunks,
  symbols,
  edges,
  files,
  memories,
  skills,
  projects
restart identity
cascade;
drop index if exists chunks_embed_hnsw;
drop index if exists memories_embed_hnsw;
drop index if exists skills_embed_hnsw;
alter table chunks   alter column embedding type vector(384) using null;
alter table memories alter column embedding type vector(384) using null;
alter table skills   alter column embedding type vector(384) using null;
create index if not exists chunks_embed_hnsw   on chunks   using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index if not exists memories_embed_hnsw on memories using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index if not exists skills_embed_hnsw   on skills   using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
drop function if exists search_chunks   (uuid, text, vector, text, text[], text, text[], int, int, int, int) cascade;
drop function if exists search_chunks    cascade;
drop function if exists expand_graph     cascade;
drop function if exists impact           cascade;
drop function if exists resolve_edges    cascade;
drop function if exists recall_memories  cascade;
alter table projects alter column embedding_model set default 'Xenova/all-MiniLM-L6-v2';
alter table projects alter column embedding_dim   set default 384;

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
create or replace function expand_graph(
  p_project      uuid,
  p_ref          text,
  p_seed_symbols uuid[],
  p_max_hops     int    default 2,
  p_kinds        text[] default null
)
returns table (
  symbol_id   uuid,
  fqn         text,
  kind        text,
  file_path   text,
  hop         int,
  via_edge    text,
  from_symbol uuid
)
language sql
stable
as $$
  with recursive walk as (
    select s.id as symbol_id, s.fqn, s.kind,
           0 as hop, null::text as via_edge, null::uuid as from_symbol
    from symbols s
    where s.id = any(p_seed_symbols) and s.project_id = p_project and s.ref = p_ref
    union
    select nb.id, nb.fqn, nb.kind,
           w.hop + 1, e.kind, w.symbol_id
    from walk w
    join edges e
      on (e.src_symbol_id = w.symbol_id or e.dst_symbol_id = w.symbol_id)
     and e.project_id = p_project
     and e.ref = p_ref
     and e.dst_symbol_id is not null
     and (p_kinds is null or e.kind = any(p_kinds))
    join symbols nb
      on nb.id = case when e.src_symbol_id = w.symbol_id
                      then e.dst_symbol_id else e.src_symbol_id end
    where w.hop < p_max_hops
  )
  select w.symbol_id, w.fqn, w.kind, f.path, w.hop, w.via_edge, w.from_symbol
  from walk w
  join symbols sy on sy.id = w.symbol_id
  join files   f  on f.id  = sy.file_id;
$$;
create or replace function impact(
  p_project   uuid,
  p_ref       text,
  p_symbol    uuid,
  p_max_depth int default 3
)
returns table (
  symbol_id uuid,
  fqn       text,
  kind      text,
  file_path text,
  depth     int
)
language sql
stable
as $$
  with recursive up as (
    select s.id as symbol_id, s.fqn, s.kind, 0 as depth
    from symbols s
    where s.id = p_symbol and s.project_id = p_project and s.ref = p_ref
    union
    select src.id, src.fqn, src.kind, u.depth + 1
    from up u
    join edges e
      on e.dst_symbol_id = u.symbol_id
     and e.project_id = p_project
     and e.ref = p_ref
     and e.kind in ('calls','references','implements','extends')
    join symbols src on src.id = e.src_symbol_id
    where u.depth < p_max_depth
  )
  select u.symbol_id, u.fqn, u.kind, f.path, u.depth
  from up u
  join symbols sy on sy.id = u.symbol_id
  join files   f  on f.id  = sy.file_id
  where u.depth > 0;
$$;
create or replace function resolve_edges(p_project uuid, p_ref text)
returns integer
language plpgsql
volatile
as $$
declare
  n integer;
begin
  with resolved as (
    update edges e
    set dst_symbol_id = s.id, dst_fqn = null
    from symbols s
    where e.project_id = p_project
      and e.ref = p_ref
      and e.dst_symbol_id is null
      and e.dst_fqn is not null
      and s.project_id = e.project_id
      and s.ref = e.ref
      and s.fqn = e.dst_fqn
    returning e.id
  )
  select count(*) into n from resolved;
  return n;
end;
$$;
create or replace function recall_memories(
  p_project          uuid,
  p_query_embedding  vector(384),
  p_query_text       text,
  p_session          text   default null,
  p_kinds            text[] default null,
  p_k                int    default 10,
  p_half_life_days   real   default 30.0,
  p_ef_search        int    default 100
)
returns table (
  id           uuid,
  kind         text,
  title        text,
  content      text,
  session_id   text,
  created_at   timestamptz,
  score        real
)
language plpgsql
stable
as $$
begin
  perform set_config('hnsw.ef_search', p_ef_search::text, true);
  return query
  with cand as (
    select m.id, m.kind, m.title, m.content, m.session_id, m.created_at, m.confidence,
           1 - (m.embedding <=> p_query_embedding) as sim,
           case when p_query_text is null then 0
                else ts_rank_cd(m.fts, websearch_to_tsquery('english', p_query_text)) end as lex,
           exp( -ln(2) * extract(epoch from (now() - m.created_at))
                / (p_half_life_days * 86400) ) as recency
    from memories m
    where m.project_id = p_project
      and m.superseded_by is null
      and (p_session is null or m.session_id = p_session)
      and (p_kinds   is null or m.kind = any(p_kinds))
      and m.embedding is not null
  )
  select cand.id, cand.kind, cand.title, cand.content, cand.session_id, cand.created_at,
         (0.55 * sim + 0.20 * least(lex, 1.0) + 0.20 * recency + 0.05 * confidence)::real as score
  from cand
  order by score desc
  limit p_k;
end;
$$;

commit;

-- ✅ Done. All data wiped, dim=384, RPCs recreated. Re-index projects now.
