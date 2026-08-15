alter table public.registry_snapshots
  add column admission_envelopes jsonb not null default '{}'::jsonb;

alter table public.registry_snapshots
  add column published_by uuid;

create table public.policy_profiles (
  id text primary key,
  name text not null,
  allowed_platforms text[],
  allowed_capability_packs text[],
  created_at timestamptz not null default now()
);

alter table public.policy_profiles enable row level security;

create policy "service role full access to policy_profiles"
  on public.policy_profiles
  for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.policy_profiles to service_role;

revoke all on public.policy_profiles from anon, authenticated;

alter table public.projects
  add column policy_profile_id text references public.policy_profiles(id);

create table public.activation_records (
  id uuid primary key default gen_random_uuid(),
  project_id text references public.projects(id),
  channel text not null,
  snapshot_id uuid not null references public.registry_snapshots(id),
  generation_digest text not null,
  claude_code_version text not null,
  capabilities text[] not null default '{}',
  activated_at timestamptz not null default now()
);

alter table public.activation_records enable row level security;

create policy "service role full access to activation_records"
  on public.activation_records
  for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.activation_records to service_role;

revoke all on public.activation_records from anon, authenticated;

create table public.snapshot_reviews (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.registry_snapshots(id),
  reviewer_user_id uuid not null,
  decision text not null check (decision in ('approved', 'rejected')),
  comment text,
  reviewed_at timestamptz not null default now()
);

alter table public.snapshot_reviews enable row level security;

create policy "service role full access to snapshot_reviews"
  on public.snapshot_reviews
  for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.snapshot_reviews to service_role;

revoke all on public.snapshot_reviews from anon, authenticated;
