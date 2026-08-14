#!/usr/bin/env bash
set -euo pipefail
MODULE="$SUBMODULE/cipherpol-1"
deploy_out="$SUBMODULE/dist/deploy/cipherpol-1"
cp "$MODULE"/package.json "$MODULE"/pnpm-lock.yaml "$MODULE"/pnpm-workspace.yaml \
  "$MODULE"/tsconfig.json "$MODULE"/tsconfig.base.json "$deploy_out/"
for pkg_dir in "$MODULE"/packages/*/; do
  [ -f "$pkg_dir/package.json" ] && [ -d "$pkg_dir/src" ] || continue
  cp -r "$pkg_dir/src" "$deploy_out/packages/$(basename "$pkg_dir")/src"
  cp "$pkg_dir/package.json" "$pkg_dir/tsconfig.json" "$deploy_out/packages/$(basename "$pkg_dir")/"
done
cp "$MODULE/packages/mcp-server/Dockerfile" "$deploy_out/Dockerfile"
cp "$MODULE"/deploy/supabase-min/{docker-compose.yml,Caddyfile,.env.example} "$deploy_out/"
cp -r "$MODULE/deploy/supabase-min/volumes" "$deploy_out/volumes"
cp "$MODULE/deploy/supabase-min/kong.yml" "$deploy_out/volumes/api/kong.yml"
cp -r "$MODULE/supabase/migrations" "$deploy_out/supabase/migrations"
