#!/usr/bin/env bash
# db-reset.sh — wipe user data and restart the shipwright database
#
# Destroys: shipwright postgres (db_data), rustfs object storage (rustfs_data)
# Preserves: langfuse, clickhouse, redis, tei model cache
#
# Usage:
#   pnpm db:reset          (from repo root)
#   ./scripts/db-reset.sh  (directly)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_URL="postgres://shipwright:shipwright@localhost:5433/shipwright"

echo "==> Stopping all containers..."
docker compose -f "$REPO_ROOT/docker-compose.yml" down

echo "==> Removing app data volumes (db_data, rustfs_data)..."
docker volume rm shipwright_db_data shipwright_rustfs_data 2>/dev/null || true

echo "==> Starting containers..."
docker compose -f "$REPO_ROOT/docker-compose.yml" up -d

echo "==> Waiting for postgres to be ready..."
until docker exec shipwright-postgres-1 pg_isready -U shipwright -d shipwright -q 2>/dev/null; do
  sleep 1
done

echo "==> Pushing schema..."
(cd "$REPO_ROOT/apps/api" && pnpm db:push)

echo "==> Done. Connect with:"
echo "    psql $DB_URL"
