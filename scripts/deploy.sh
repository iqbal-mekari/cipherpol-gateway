#!/usr/bin/env bash
set -euo pipefail

# Deploy the cipherpol-gateway pnpm workspace to the VPS and restart the
# control-plane systemd service.
#
# Expected to run on a GitHub Actions runner after:
#   - the ed25519 deploy key has been loaded into ssh-agent
#   - the VPS host has been added to known_hosts
# The VPS host is read from the VPS_HOST environment variable.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${VPS_HOST:?VPS_HOST must be set to the VPS hostname or IP address}"

cd "$REPO_ROOT"

# Sync the whole workspace: the control-plane uses `workspace:*` internal deps
# and runs directly via `tsx` (no compiled build step), so the full monorepo
# must be present at runtime. Exclude VCS metadata, dependency directories, the
# agentic-registry test fixtures (not needed at runtime), and local tooling
# state.
rsync -az --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='**/node_modules' \
  --exclude='fixtures/software-dev-agentic-registry' \
  --exclude='.superpowers' \
  ./ "root@${VPS_HOST}:/opt/cipherpol-gateway/"

# Install, restart the service, then verify the health endpoint in a single SSH
# round-trip. If the curl health check fails (non-2xx / connection refused),
# ssh exits non-zero, which (via `set -e`) fails this script and therefore the
# workflow. Port 4100 is the control-plane default (PORT in src/env.ts).
ssh -o StrictHostKeyChecking=accept-new "root@${VPS_HOST}" \
  "cd /opt/cipherpol-gateway && pnpm install --frozen-lockfile && systemctl restart cipherpol-control-plane && sleep 2 && curl -sf http://127.0.0.1:4100/health"
