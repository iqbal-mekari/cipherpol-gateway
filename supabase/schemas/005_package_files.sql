create table public.package_files (
  package_id text not null,
  version text not null,
  path text not null,
  content bytea not null,
  mode integer not null,
  created_at timestamptz not null default now(),
  primary key (package_id, version, path)
);

alter table public.package_files enable row level security;

create policy "service role full access to package_files"
  on public.package_files
  for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.package_files to service_role;

revoke all on public.package_files from anon, authenticated;
