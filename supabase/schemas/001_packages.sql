create table public.packages (
  id text not null,
  version text not null,
  kind text not null,
  digest text not null,
  owner text not null,
  source_revision text not null,
  artifact_path text not null,
  compatibility jsonb not null,
  dependencies text[] not null default '{}',
  files jsonb not null,
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (id, version)
);

alter table public.packages enable row level security;

create policy "service role full access to packages"
  on public.packages
  for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.packages to service_role;
revoke all on public.packages from anon, authenticated;

create table public.capability_packs (
  id text not null,
  version text not null,
  intents text[] not null,
  platforms text[] not null,
  orchestrator text not null,
  packages text[] not null,
  playbooks text[] not null default '{}',
  tool_bundle text,
  required_evidence text[] not null default '{}',
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (id, version)
);

alter table public.capability_packs enable row level security;

create policy "service role full access to capability_packs"
  on public.capability_packs
  for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.capability_packs to service_role;
revoke all on public.capability_packs from anon, authenticated;

create table public.playbooks (
  id text not null,
  version text not null,
  owner text not null,
  platforms text[] not null,
  guidance_packages text[] not null default '{}',
  hook_packages text[] not null default '{}',
  validator_packages text[] not null default '{}',
  rules jsonb not null,
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (id, version)
);

alter table public.playbooks enable row level security;

create policy "service role full access to playbooks"
  on public.playbooks
  for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.playbooks to service_role;
revoke all on public.playbooks from anon, authenticated;
