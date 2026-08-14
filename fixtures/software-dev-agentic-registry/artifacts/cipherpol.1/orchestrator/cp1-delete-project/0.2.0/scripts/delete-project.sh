#!/usr/bin/env bash
# Delete a project (or a single ref/snapshot) from the shared cp1 knowledge base.
# No MCP server involved — like index-project, this runs the same
# deleteProject()/deleteRef() pipeline directly via `pnpm delete`.
#
# Usage:
#   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
#     delete-project.sh <toolkit_root> <slug> [ref] [--confirm]
#
#   toolkit_root  path to a local mobile-agentic-toolkit checkout (cloned here if
#                 missing); the workspace itself is its cipherpol-1/ subdir
#   slug          project identifier to delete
#   ref           optional — delete only this snapshot (e.g. branch:main).
#                 Omit to delete the ENTIRE project (irreversible).
#   --confirm     without it, only a preview is shown — nothing is deleted.
set -euo pipefail

TOOLKIT_ROOT="${1:?toolkit_root required}"
SLUG="${2:?slug required}"
shift 2

REF=""
CONFIRM=""
for arg in "$@"; do
  case "$arg" in
    --confirm) CONFIRM="--confirm" ;;
    *) REF="$arg" ;;
  esac
done

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

ARGS=("$SLUG")
if [ -n "$REF" ]; then
  ARGS+=(--ref "$REF")
fi
if [ -n "$CONFIRM" ]; then
  ARGS+=(--confirm)
fi

pnpm delete "${ARGS[@]}"
