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
# round-trip. `tsx` compiles/loads ESM modules on process start, so boot time
# is not fixed — poll instead of a fixed sleep. If the health check never
# succeeds within the retry budget, curl's final failing exit code propagates
# through the loop's `exit`, failing this script and therefore the workflow.
# Port 4100 is the control-plane default (PORT in src/env.ts).
ssh -o StrictHostKeyChecking=accept-new "root@${VPS_HOST}" '
  set -euo pipefail
  cd /opt/cipherpol-gateway
  pnpm install --frozen-lockfile
  systemctl restart cipherpol-control-plane
  for attempt in $(seq 1 15); do
    if curl -sf http://127.0.0.1:4100/health >/dev/null; then
      echo "health check passed after ${attempt} attempt(s)"
      exit 0
    fi
    sleep 1
  done
  echo "health check never succeeded within 15s" >&2
  systemctl status cipherpol-control-plane --no-pager -l >&2 || true
  journalctl -u cipherpol-control-plane -n 40 --no-pager >&2 || true
  exit 1
'
