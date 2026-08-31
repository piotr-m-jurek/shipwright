# oven/bun:1-slim includes ca-certificates needed for Neon SSL
FROM oven/bun:1.3.1-slim AS runtime
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

RUN bun install --frozen-lockfile --production --ignore-scripts

# Copy source — no build step, Bun runs TypeScript directly
COPY apps/api/src ./apps/api/src
COPY packages/shared/src ./packages/shared/src

# Copy migration SQL files
COPY apps/api/src/db/out ./apps/api/src/db/out

EXPOSE 3000
ENV NODE_ENV=production

CMD ["bun", "apps/api/src/server/main.ts"]
