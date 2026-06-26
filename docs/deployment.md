# Shipwright — Deployment Plan

> **Status:** Platform TBD. Principles and CI/CD pattern are locked.
> Platform-specific Terraform resources to be filled in when the hosting
> target is decided.
>
> **When to read this:** Before Phase 8b (Queue Port) is complete and you
> are ready to ship the app to real users.

---

## Principles (platform-agnostic)

These apply regardless of which cloud platform is chosen.

### Single Docker image

One image contains the full application:

- `apps/api` built to `apps/api/dist/`
- `apps/web` built to `apps/web/dist/` — static files copied into the image
- Effect server serves both: `/api/*` routes to the handler pipeline,
  everything else served as static files with SPA fallback

No nginx sidecar. No separate static file host. One container, one process.

### Secrets via environment variables only

No `.env` files inside the Docker image. All secrets (DB connection string,
S3 credentials, LLM API keys, auth secrets) are injected as environment
variables at runtime by the platform's secrets management.

`.env.example` at repo root documents every required variable.

### Migrations as a pre-deploy step

`drizzle-kit migrate` runs **before** the new container starts serving traffic.
It does not run at server startup — a server that auto-migrates is a risk in
horizontal deployments (multiple instances racing to migrate).

CI/CD deploy job order: build image → push → run migration → swap traffic.

### Health check endpoint

`GET /api/health` returns `200 OK` with `{ status: "ok", version: "..." }`.
Used by the container platform's health check to determine when the container
is ready to receive traffic and when to restart it.

Add this endpoint during Phase 8b or Phase 10, whichever comes first.

### pgvector requirement

The managed Postgres instance (or self-hosted container) **must** have the
`pgvector` extension available. Not all managed Postgres providers support it.
Verify before committing to a platform.

---

## Docker

### Multi-stage Dockerfile

```dockerfile
# Stage 1: build
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm -r build

# Stage 2: runtime
FROM node:22-alpine AS runtime
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/web/dist ./apps/api/dist/public
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist

EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
```

**Notes:**
- `apps/web/dist` is copied into `apps/api/dist/public` — the Effect server
  serves it as static files. No separate web server needed.
- `pnpm install --prod` in the runtime stage excludes devDependencies.
- If the Effect server uses `tsx` for development, replace it with a proper
  `tsc` build target for the production image.

### Local build test

```bash
docker build -t shipwright:local .
docker run --env-file .env -p 3000:3000 shipwright:local
```

---

## CI/CD (GitHub Actions)

Two workflows:

### `ci.yml` — runs on every PR

```yaml
name: CI
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r build          # type-check via tsc
      - run: pnpm -r lint           # oxlint
      - run: pnpm --filter @shipwright/api test:phase4
```

### `deploy.yml` — runs on push to `main`

```yaml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r build
      - run: pnpm -r lint
      - run: pnpm --filter @shipwright/api test:phase4

      # Build and push Docker image
      - name: Build image
        run: docker build -t $IMAGE_TAG .
        env:
          IMAGE_TAG: ${{ secrets.REGISTRY }}/${{ github.sha }}

      - name: Push image
        run: docker push $IMAGE_TAG
        env:
          IMAGE_TAG: ${{ secrets.REGISTRY }}/${{ github.sha }}

      # Run migrations before swapping traffic
      - name: Run migrations
        run: |
          docker run --rm \
            -e DATABASE_URL=${{ secrets.DATABASE_URL }} \
            $IMAGE_TAG \
            node -e "require('./apps/api/dist/db/migrate.js')"

      # Platform-specific deploy step goes here
      # e.g. fly deploy, aws ecs update-service, railway up
      - name: Deploy
        run: echo "TODO: platform-specific deploy command"
```

**Secrets required in GitHub Actions:**

| Secret | Description |
|---|---|
| `REGISTRY` | Container registry URL (e.g. `ghcr.io/yourorg/shipwright`) |
| `DATABASE_URL` | Postgres connection string for migration step |
| `ANTHROPIC_API_KEY` | Passed to the running container |
| `OPENAI_API_KEY` | Passed to the running container |
| `AWS_ACCESS_KEY_ID` | S3-compatible storage credentials |
| `AWS_SECRET_ACCESS_KEY` | S3-compatible storage credentials |
| `BETTER_AUTH_SECRET` | Auth session signing secret (Phase 12+) |

---

## Terraform scope

> Platform-specific resources are placeholders. Fill in when platform is chosen.

### Resource categories

**Compute (container service)**
- One container service running the Shipwright Docker image
- Environment variables injected from secrets store
- Health check: `GET /api/health`
- Auto-restart on failure

**Database (Postgres + pgvector)**
- Managed Postgres instance with pgvector extension enabled
- Minimum: 1 vCPU, 1GB RAM (development), 2 vCPU, 4GB RAM (production)
- Automated backups enabled
- Connection string exposed as a secret to the container service

**Object storage (S3-compatible)**
- One bucket for session uploads and output files
- CORS policy: allow PUT from frontend origin (presigned URL uploads)
- Lifecycle policy: delete incomplete multipart uploads after 1 day

**Secrets store**
- All secrets (API keys, DB URL, auth secret) stored in the platform's
  secrets manager, not hardcoded in Terraform or the Docker image

**Networking**
- HTTPS termination at the platform edge (not in the container)
- Custom domain pointing to the container service

### Placeholder `main.tf` structure

```hcl
# Fill in provider and resources when platform is decided

terraform {
  required_version = ">= 1.6"
  backend "s3" {}  # or platform equivalent
}

# provider "fly" {}        # Fly.io
# provider "aws" {}        # AWS ECS + RDS
# provider "render" {}     # Render

# resource "PLATFORM_postgres" "main" { ... }
# resource "PLATFORM_container" "api" { ... }
# resource "PLATFORM_storage_bucket" "uploads" { ... }
```

---

## Platform decision

> Decide when traffic requirements are known. Below are the key tradeoffs.

| | Fly.io | AWS ECS + RDS | Railway | Render |
|---|---|---|---|---|
| pgvector support | via Fly Postgres (self-managed) | RDS with pgvector extension | yes (managed) | yes (managed) |
| Terraform provider | `fly-apps/fly` (unofficial) | `hashicorp/aws` (official, mature) | limited | limited |
| Ops complexity | low | high | very low | very low |
| Cost at low scale | low (~$10-20/mo) | moderate (~$50-100/mo) | low (~$10-20/mo) | low (~$10-20/mo) |
| Horizontal scaling | yes (fly scale count) | yes (ECS desired count) | yes | yes |
| Custom domain + TLS | yes, built-in | yes, ALB needed | yes, built-in | yes, built-in |
| Notes | Best fit for single-server Effect app. Self-managed Postgres means you own pgvector setup. | Most Terraform coverage. Highest setup overhead. Right if org is AWS-first. | Lowest friction. Limited Terraform. Right if you want zero infra config. | Similar to Railway. |

**Recommendation when ready:** Fly.io for the first deploy. Low cost, simple
deploys (`fly deploy`), Fly Postgres supports pgvector. Migrate to AWS ECS if
you need enterprise-grade SLAs or the org is already AWS-native.

---

## Open items (fill in before first deploy)

- [ ] Choose platform and fill in Terraform provider + resources
- [ ] Set up container registry (GitHub Container Registry or platform registry)
- [ ] Add `GET /api/health` endpoint to `apps/api`
- [ ] Add `apps/api/src/db/migrate.ts` — standalone migration script (not auto-run at startup)
- [ ] Configure CORS on the Effect server for the production frontend domain
- [ ] Set `BETTER_AUTH_URL` to the production domain (Phase 12+)
- [ ] Verify pgvector extension is enabled on the chosen managed Postgres
- [ ] Test `docker build` locally before first CI deploy
