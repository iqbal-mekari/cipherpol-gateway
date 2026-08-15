-- Migration unit 1: schema_changes
-- Transaction mode: transactional
-- Boundary reason: default

ALTER TABLE public.registry_snapshots
  ALTER COLUMN published_by TYPE text USING published_by::text;

ALTER TABLE public.snapshot_reviews
  DROP COLUMN reviewer_user_id;

ALTER TABLE public.snapshot_reviews
  ADD COLUMN reviewer_email text NOT NULL;