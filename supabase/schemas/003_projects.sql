create table public.projects (
  id text primary key,
  slug text not null unique,
  name text not null,
  default_channel text not null check (default_channel in ('canary', 'stable', 'pinned')),
  platforms text[] not null,
  owners text[] not null,
  registered_at timestamptz not null default now()
);

alter table public.projects enable row level security;

create policy "service role full access to projects"
  on public.projects
  for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.projects to service_role;

revoke all on public.projects from anon, authenticated;
