#!/usr/bin/env bash
# Index a project into the shared cp1 knowledge base (Supabase-backed).
# No MCP server involved — runs the same indexProject() pipeline the MCP
# tool uses, directly, so it never needs a local stdio MCP entry just for
# this one tool.
#
# Usage:
#   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
#     index-project.sh <toolkit_root> <project_path> <slug> [ref] [commit]
#
#   toolkit_root   path to a local mobile-agentic-toolkit checkout (cloned here if
#                  missing); the workspace itself is its cipherpol-1/ subdir
#   project_path   absolute path to the codebase to index
#   slug           project identifier (folder name under projects/)
#   ref            snapshot ref, e.g. branch:main (default: branch:main)
#   commit         optional git commit SHA
set -euo pipefail

TOOLKIT_ROOT="${1:?toolkit_root required}"
PROJECT_PATH="${2:?project_path required}"
SLUG="${3:?slug required}"
REF="${4:-branch:main}"
COMMIT="${5:-}"

REPO_URL="${CP1_REPO_URL:-git@bitbucket.org:mid-kelola-indonesia/mobile-agentic-toolkit.git}"

: "${SUPABASE_URL:?SUPABASE_URL must be set}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY must be set}"

if [ ! -d "$TOOLKIT_ROOT" ]; then
  echo "Cloning mobile-agentic-toolkit into $TOOLKIT_ROOT ..."
  git clone --depth 1 "$REPO_URL" "$TOOLKIT_ROOT"
fi

WORKSPACE="$TOOLKIT_ROOT/cipherpol-1"
[ -f "$WORKSPACE/package.json" ] || {
  echo "Error: $WORKSPACE is not a cipherpol-1 workspace (no package.json)." >&2
  exit 1
}

cd "$WORKSPACE"

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only) ..."
  pnpm install
fi

ARGS=("$PROJECT_PATH" --slug "$SLUG" --ref "$REF" --include-source)
if [ -n "$COMMIT" ]; then
  ARGS+=(--commit "$COMMIT")
fi

echo "Indexing $SLUG @ $REF ..."
pnpm index "${ARGS[@]}"
