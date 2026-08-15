-- Migration unit 1: schema_changes
-- Transaction mode: transactional
-- Boundary reason: default

CREATE TABLE public.activation_records (
  id                  uuid                     DEFAULT gen_random_uuid() NOT NULL,
  project_id          text,
  channel             text                     NOT NULL,
  snapshot_id         uuid                     NOT NULL,
  generation_digest   text                     NOT NULL,
  claude_code_version text                     NOT NULL,
  capabilities        text[]                   DEFAULT '{}'::text[] NOT NULL,
  activated_at        timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.activation_records
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.activation_records
  ADD CONSTRAINT activation_records_pkey PRIMARY KEY (id);

ALTER TABLE public.activation_records
  ADD CONSTRAINT activation_records_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);

ALTER TABLE public.activation_records
  ADD CONSTRAINT activation_records_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.registry_snapshots(id);

GRANT ALL ON public.activation_records TO service_role;

CREATE POLICY "service role full access to activation_records" ON public.activation_records
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE TABLE public.policy_profiles (
  id                       text                     NOT NULL,
  name                     text                     NOT NULL,
  allowed_platforms        text[],
  allowed_capability_packs text[],
  created_at               timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.policy_profiles
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.policy_profiles
  ADD CONSTRAINT policy_profiles_pkey PRIMARY KEY (id);

GRANT ALL ON public.policy_profiles TO service_role;

CREATE POLICY "service role full access to policy_profiles" ON public.policy_profiles
  TO service_role
  USING (true)
  WITH CHECK (true);

ALTER TABLE public.projects
  ADD COLUMN policy_profile_id text;

ALTER TABLE public.projects
  ADD CONSTRAINT projects_policy_profile_id_fkey FOREIGN KEY (policy_profile_id) REFERENCES public.policy_profiles(id);

ALTER TABLE public.registry_snapshots
  ADD COLUMN admission_envelopes jsonb DEFAULT '{}'::jsonb NOT NULL;

ALTER TABLE public.registry_snapshots
  ADD COLUMN published_by uuid;

CREATE TABLE public.snapshot_reviews (
  id               uuid                     DEFAULT gen_random_uuid() NOT NULL,
  snapshot_id      uuid                     NOT NULL,
  reviewer_user_id uuid                     NOT NULL,
  decision         text                     NOT NULL,
  comment          text,
  reviewed_at      timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.snapshot_reviews
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.snapshot_reviews
  ADD CONSTRAINT snapshot_reviews_decision_check CHECK (decision = ANY (ARRAY['approved'::text, 'rejected'::text]));

ALTER TABLE public.snapshot_reviews
  ADD CONSTRAINT snapshot_reviews_pkey PRIMARY KEY (id);

ALTER TABLE public.snapshot_reviews
  ADD CONSTRAINT snapshot_reviews_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES public.registry_snapshots(id);

GRANT ALL ON public.snapshot_reviews TO service_role;

CREATE POLICY "service role full access to snapshot_reviews" ON public.snapshot_reviews
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON public.activation_records FROM anon;

REVOKE ALL ON public.activation_records FROM authenticated;

REVOKE ALL ON public.policy_profiles FROM anon;

REVOKE ALL ON public.policy_profiles FROM authenticated;

REVOKE ALL ON public.snapshot_reviews FROM anon;

REVOKE ALL ON public.snapshot_reviews FROM authenticated;