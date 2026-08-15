-- Migration unit 1: schema_changes
-- Transaction mode: transactional
-- Boundary reason: default

CREATE TABLE public.projects (
  id              text                     NOT NULL,
  slug            text                     NOT NULL,
  name            text                     NOT NULL,
  default_channel text                     NOT NULL,
  platforms       text[]                   NOT NULL,
  owners          text[]                   NOT NULL,
  registered_at   timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.projects
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.projects
  ADD CONSTRAINT projects_default_channel_check CHECK (default_channel = ANY (ARRAY['canary'::text, 'stable'::text, 'pinned'::text]));

ALTER TABLE public.projects
  ADD CONSTRAINT projects_pkey PRIMARY KEY (id);

ALTER TABLE public.projects
  ADD CONSTRAINT projects_slug_key UNIQUE (slug);

GRANT ALL ON public.projects TO service_role;

CREATE POLICY "service role full access to projects" ON public.projects
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON public.projects FROM anon;

REVOKE ALL ON public.projects FROM authenticated;