# Build Progress Log

> Running log of completed phases, decisions made, and issues encountered.
> Read this before starting a new session.

---

## Phase 0 — Scaffold (COMPLETE)

### What was built
- Single `package.json` monolith (no monorepo)
- Folder structure: `src/api/`, `src/agent/`, `src/db/`, `src/storage/`, `src/shared/`, `src/web/`
- Hono API server embedded in Vite dev server via `@hono/vite-dev-server` (single port: 5173)
- React frontend in `src/web/` with `@vitejs/plugin-react`
- Full Drizzle schema in `src/db/schema.ts` — all 7 tables, all columns, relations wired
- `StorageAdapter` interface + `S3Storage` implementation using `@aws-sdk/client-s3`
- Docker Compose: `pgvector/pgvector:pg17` on port 5433 + `rustfs/rustfs` on port 9000
- `docker/init.sql` auto-enables pgvector extension on first container start
- `src/config.ts` — typed config with `envOrThrow`, covers DB and storage
- `.env.example` with all required variables documented
- Hono route stubs in `src/api/index.ts` (all 5 routes from the spec)

### Key decisions
- **Single Vite dev server** (not two separate servers) — Hono embedded via `@hono/vite-dev-server`
- **Port 5433** for Postgres — local Postgres was already running on 5432
- **rustfs** chosen over garage — simpler setup, no init ceremony
- **`@aws-sdk/client-s3`** for storage — not Bun's built-in S3 client (Rule 4 compliance, provider portability)
- **drizzle-orm v1.0.0-beta** — using `defineRelations` (new v1 beta API, not old `relations` helper)
- **TypeScript 5.8** — not 6.x (React 19 types not compatible with TS 6 pre-release)

### Deviations from build sequence
- `src/web/` used instead of `src/client/` — functionally equivalent, matches build sequence intent

### Architecture rules status
All 10 rules checked — no violations at Phase 0.

### Gate verification
- `drizzle-kit push` succeeds
- `SELECT * FROM sessions LIMIT 1` returns empty result
- `SELECT extname FROM pg_extension WHERE extname = 'vector'` returns a row
- S3 upload and download via `@aws-sdk/client-s3` against rustfs succeeds

---

## Phase 1 — Document Ingestion (NOT STARTED)

Next steps per `docs/build_sequence.md`:
- File upload endpoint on Hono (`POST /api/sessions`, multipart)
- Parsers: `unpdf` (PDF), `mammoth.extractRawText()` (DOCX), `fs/promises` (plain text)
- Custom recursive character chunker with overlap
- Metadata tagging per chunk: `sourceDocument`, `documentType`, `chunkIndex`, `sessionId`
- Embed chunks via `OpenAI text-embedding-3-small` through Vercel AI SDK `embed()`
- Store chunks in pgvector via Drizzle `vector()` column
- Store raw files via `StorageAdapter`
- Store `tokenCount` on `documents` table
- Zod schemas in `src/shared/schemas/documents.ts`: `DocumentTypeSchema`, `UploadRequestSchema`, `ChunkMetaSchema`
- Validate upload endpoint body with `@hono/zod-validator`

Gate: upload a PDF, query semantically related chunks back out.

### Decisions during Phase 1

- **Better Auth withdrawn** — drizzle-orm v1 beta + Better Auth compatibility risk. Auth deferred until drizzle reaches stable 1.0. No `users` table, no auth layer, no presigned upload flow. Reverted to original simple multipart `POST /api/sessions` pattern.
- `agentSessions` rename retained — good separation regardless of auth status.
- Image support (PNG/JPEG/WebP) deferred — was tied to auth scope expansion, not in original spec.
