-- ============================================================================
-- 0005_file_provenance.sql — lightweight git-log provenance per file
-- ----------------------------------------------------------------------------
-- Captured once per index run via a single `git log --name-only` walk (see
-- @kb/extractor's fileProvenance), NOT a full git-blame — just the last commit
-- that touched each file: hash, author, author date, and the commit subject
-- line. Surfaced today via get_symbol; a hook for future enhancements, not a
-- full provenance UI.
-- ============================================================================

alter table files
  add column if not exists last_commit_hash    text,
  add column if not exists last_commit_author  text,
  add column if not exists last_commit_date    timestamptz,
  add column if not exists last_commit_subject text;
