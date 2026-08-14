# Build context must be the repo root (needs the full pnpm workspace for
# symlinked package resolution — packages export raw .ts, run via tsx).
FROM node:20-slim

RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production
EXPOSE 3900

CMD ["pnpm", "exec", "tsx", "packages/mcp-server/src/http-server.ts"]
