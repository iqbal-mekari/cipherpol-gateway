-- Migration unit 1: schema_changes
-- Transaction mode: transactional
-- Boundary reason: default

CREATE TABLE public.package_files (
  package_id text                     NOT NULL,
  version    text                     NOT NULL,
  path       text                     NOT NULL,
  content    bytea                    NOT NULL,
  mode       integer                  NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.package_files
  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.package_files
  ADD CONSTRAINT package_files_pkey PRIMARY KEY (package_id, VERSION, path);

GRANT ALL ON public.package_files TO service_role;

CREATE POLICY "service role full access to package_files" ON public.package_files
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON public.package_files FROM anon;

REVOKE ALL ON public.package_files FROM authenticated;