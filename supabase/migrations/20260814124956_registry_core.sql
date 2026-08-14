-- Migration unit 1: schema_changes
-- Transaction mode: transactional
-- Boundary reason: default

CREATE TABLE public.capability_packs (
  id                text                     NOT NULL,
  version           text                     NOT NULL,
  intents           text[]                   NOT NULL,
  platforms         text[]                   NOT NULL,
  orchestrator      text                     NOT NULL,
  packages          text[]                   NOT NULL,
  playbooks         text[]                   DEFAULT '{}'::text[] NOT NULL,
  tool_bundle       text,
  required_evidence text[]                   DEFAULT '{}'::text[] NOT NULL,
  revoked           boolean                  DEFAULT false NOT NULL,
  created_at        timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.capability_packs
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.capability_packs
  ADD CONSTRAINT capability_packs_pkey PRIMARY KEY (id, VERSION);

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON public.capability_packs TO anon;

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON public.capability_packs TO authenticated;

GRANT ALL ON public.capability_packs TO service_role;

CREATE POLICY "service role full access to capability_packs" ON public.capability_packs
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE TABLE public.packages (
  id              text                     NOT NULL,
  version         text                     NOT NULL,
  kind            text                     NOT NULL,
  digest          text                     NOT NULL,
  owner           text                     NOT NULL,
  source_revision text                     NOT NULL,
  artifact_path   text                     NOT NULL,
  compatibility   jsonb                    NOT NULL,
  dependencies    text[]                   DEFAULT '{}'::text[] NOT NULL,
  files           jsonb                    NOT NULL,
  revoked         boolean                  DEFAULT false NOT NULL,
  created_at      timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.packages
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.packages
  ADD CONSTRAINT packages_pkey PRIMARY KEY (id, VERSION);

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON public.packages TO anon;

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON public.packages TO authenticated;

GRANT ALL ON public.packages TO service_role;

CREATE POLICY "service role full access to packages" ON public.packages
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE TABLE public.playbooks (
  id                 text                     NOT NULL,
  version            text                     NOT NULL,
  owner              text                     NOT NULL,
  platforms          text[]                   NOT NULL,
  guidance_packages  text[]                   DEFAULT '{}'::text[] NOT NULL,
  hook_packages      text[]                   DEFAULT '{}'::text[] NOT NULL,
  validator_packages text[]                   DEFAULT '{}'::text[] NOT NULL,
  rules              jsonb                    NOT NULL,
  revoked            boolean                  DEFAULT false NOT NULL,
  created_at         timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.playbooks
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.playbooks
  ADD CONSTRAINT playbooks_pkey PRIMARY KEY (id, VERSION);

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON public.playbooks TO anon;

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON public.playbooks TO authenticated;

GRANT ALL ON public.playbooks TO service_role;

CREATE POLICY "service role full access to playbooks" ON public.playbooks
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE TABLE public.registry_snapshots (
  id                uuid                     DEFAULT gen_random_uuid() NOT NULL,
  channel           text                     NOT NULL,
  source_revision   text                     NOT NULL,
  key_id            text                     NOT NULL,
  key_purpose       text                     NOT NULL,
  registry_envelope jsonb                    NOT NULL,
  ingested_at       timestamp with time zone DEFAULT now() NOT NULL,
  superseded_at     timestamp with time zone
);

ALTER TABLE public.registry_snapshots
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.registry_snapshots
  ADD CONSTRAINT registry_snapshots_key_purpose_check CHECK (key_purpose = ANY (ARRAY['fixture'::text, 'production'::text]));

ALTER TABLE public.registry_snapshots
  ADD CONSTRAINT registry_snapshots_pkey PRIMARY KEY (id);

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON public.registry_snapshots TO anon;

GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON public.registry_snapshots TO authenticated;

GRANT ALL ON public.registry_snapshots TO service_role;

CREATE UNIQUE INDEX registry_snapshots_current_per_channel ON public.registry_snapshots (channel)
  WHERE superseded_at IS NULL;

CREATE POLICY "service role full access to registry_snapshots" ON public.registry_snapshots
  TO service_role
  USING (true)
  WITH CHECK (true);