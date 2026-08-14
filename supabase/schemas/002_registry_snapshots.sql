create table public.registry_snapshots (
  id uuid primary key default gen_random_uuid(),
  channel text not null,
  source_revision text not null,
  key_id text not null,
  key_purpose text not null check (key_purpose in ('fixture', 'production')),
  registry_envelope jsonb not null,
  ingested_at timestamptz not null default now(),
  superseded_at timestamptz
);

alter table public.registry_snapshots enable row level security;

create policy "service role full access to registry_snapshots"
  on public.registry_snapshots
  for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.registry_snapshots to service_role;

create unique index registry_snapshots_current_per_channel
  on public.registry_snapshots (channel)
  where superseded_at is null;
