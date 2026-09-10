import { describe, it, expect, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Effect, Layer, Option, Redacted, pipe } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { NodeHttpServer } from "@effect/platform-node";
import { S3Client, PutObjectCommand, CreateBucketCommand } from "@aws-sdk/client-s3";
import { ConfigService } from "@shipwright/config";
import { StorageAdapter } from "@shipwright/storage";
import { Api } from "@shipwright/shared/api";
import { Authorization, CurrentUser } from "@shipwright/shared/middleware";
import { ApiLayer, ApiGroupsLayer, InfrastructureLayer } from "./server";
import { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";
import { DocumentRepository } from "@shipwright/db/repositories/document-repository";
import { ChunkRepository } from "@shipwright/db/repositories/chunk-repository";
import { SummaryRepository } from "@shipwright/db/repositories/summary-repository";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { AgentSessionSnapshotReader } from "@shipwright/db/repositories/agent-session-snapshot-reader";
import { AppDBLiveLayer, DB } from "@shipwright/db";
import { users } from "@shipwright/db/schema";
import { getOrRestoreActor } from "../agent/session-actor";
import { LangfuseClient } from "../observability/langfuse-client";
import { UserId, type AgentSessionId } from "@shipwright/shared/domain/ids";

// ---------------------------------------------------------------------------
// Embedder mock
// ---------------------------------------------------------------------------

vi.mock("../agent/embed-chunks.js", async () => {
  const { Effect } = await import("effect");
  return {
    embedChunks: (chunks: string[]) => Effect.succeed(chunks.map(() => Array(1024).fill(0.1))),
  };
});

// ---------------------------------------------------------------------------
// Test handler setup
// ---------------------------------------------------------------------------

const DbLayer = pipe(
  Layer.mergeAll(AgentSessionRepository.layer, DocumentRepository.layer, ChunkRepository.layer),
  Layer.provideMerge(AppDBLiveLayer),
  Layer.provide(ConfigService.layer),
);

const TestRoutes = pipe(
  ApiLayer,
  Layer.provide(NodeHttpServer.layerHttpServices),
  Layer.provide(StorageAdapter.layer),
  Layer.provide(ConfigService.layer),
);

const { handler, dispose } = HttpRouter.toWebHandler(
  TestRoutes as Layer.Layer<never, never, never>,
  {
    disableLogger: true,
  },
);

afterAll(() => dispose());

// ---------------------------------------------------------------------------
// Authenticated test handler (SHIP-180) — real Authorization (authorization.ts)
// validates a better-auth session cookie end-to-end (hashing/signing owned by
// the better-auth library, not something a test should replicate by poking
// its tables directly — confirmed by hand: a directly-inserted `sessions`
// row is NOT accepted by auth.api.getSession). Swap in a stub Authorization
// middleware instead, scoped to only these tests: the cookie value IS the
// UserId directly, so createAuthCookie below needs no DB write at all.
// ---------------------------------------------------------------------------

const TestAuthorizationLayer = Layer.succeed(
  Authorization,
  Authorization.of({
    cookie: (httpEffect, { credential }) =>
      Effect.provideService(httpEffect, CurrentUser, {
        id: UserId.make(Redacted.value(credential)),
        email: `${Redacted.value(credential)}@test.local`,
        name: "Test User",
      }),
  }),
);

const TestRoutesAuthed = pipe(
  HttpApiBuilder.layer(Api, { openapiPath: "/opencode.json" }),
  ApiGroupsLayer,
  Layer.provide(TestAuthorizationLayer),
  Layer.provide(InfrastructureLayer),
  Layer.provide(NodeHttpServer.layerHttpServices),
  Layer.provide(StorageAdapter.layer),
  Layer.provide(ConfigService.layer),
);

const { handler: authedHandler, dispose: disposeAuthed } = HttpRouter.toWebHandler(
  TestRoutesAuthed as Layer.Layer<never, never, never>,
  {
    disableLogger: true,
  },
);

afterAll(() => disposeAuthed());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runDb<A>(
  effect: Effect.Effect<A, unknown, AgentSessionRepository | DocumentRepository | ChunkRepository | DB>,
) {
  return Effect.runPromise(Effect.provide(effect, DbLayer));
}

async function post(path: string, body: unknown, cookie?: string) {
  return handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

async function get(path: string, cookie?: string) {
  return handler(
    new Request(`http://localhost${path}`, {
      headers: cookie ? { Cookie: cookie } : {},
    }),
  );
}

async function postAuthed(path: string, body: unknown, cookie: string) {
  return authedHandler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    }),
  );
}

// ---------------------------------------------------------------------------
// Auth helpers (SHIP-180) — used only against the stub-authorized handler
// above. createTestUser still inserts a real `users` row: AgentSessionRepository
// .createAgentSession's userId is a live FK into it.
// ---------------------------------------------------------------------------

async function createTestUser(email: string): Promise<string> {
  const id = randomUUID();
  await runDb(
    Effect.flatMap(DB, (d) =>
      d.insert(users).values({ id, name: "Test User", email, emailVerified: false }),
    ),
  );
  return id;
}

function createAuthCookie(userId: string): string {
  return `better-auth.session_token=${userId}`;
}

// ---------------------------------------------------------------------------
// Machine-state fabrication (SHIP-180) — reaching `analyzing`/`complete` via
// the real pipeline needs a live LLM (see SHIP-187, blocked pending API key
// access). Tried building a fresh actor's snapshot with `value` overridden
// and persisting it directly (same technique document-added-transition.test.ts
// uses) — that works in-memory, but writing it through the real repository
// and letting the HTTP layer restore it from Postgres does not: `Schema.Option`
// (MachineContextEffectSchema's `agentAnalysis`/`revisionFeedback` fields,
// packages/shared/src/schemas/machine.ts) only decodes a genuine Option
// instance, not the plain `{_id,_tag}` shape a real JSON/jsonb round-trip
// produces — confirmed by hand, `Schema.decodeUnknownEffect` fails with
// "Expected Option" on anything that has actually been through JSON.
// Looks like a real, separate bug (every session restore after a server
// restart should hit this, since `agentAnalysis` starts as `Option.none()`
// from context defaults) — flagged to the user rather than fixed here, out
// of scope for this test.
//
// Sidesteps it entirely: don't persist+restore anything. getOrRestoreActor
// caches actors in a process-wide `registry` (session-actor.ts, not
// exported) keyed by sessionId — calling it here, in the same process as
// the HTTP handler under test, registers a live actor that the handler's
// own later getOrRestoreActor call for the same sessionId will find and
// reuse directly, no DB restore involved. Drive it to a target state with
// the machine's own real events (all zero-payload) rather than a snapshot.
// `summarizing` (reached via UPLOAD_COMPLETE/DOCUMENTS_READY/USER_CONFIRM,
// no documents ever spawned) stands in for the general "busy, not
// idle/uploading/complete" case in the rejection test — good enough to
// prove the guard rejects it; the full idle/uploading/complete acceptance
// matrix (including `complete`) is already covered at the aggregate layer
// by agent-session-aggregate.test.ts's own in-memory fabrication, which
// doesn't hit this bug since it never round-trips through Postgres.
// ---------------------------------------------------------------------------

const stateFabricationLayer = Layer.mergeAll(
  Layer.succeed(ChunkRepository, {} as any),
  Layer.succeed(SummaryRepository, {} as any),
  Layer.succeed(SqlClient, {} as any),
  Layer.succeed(LangfuseClient, {} as any),
);

const ActorDriverLayer = pipe(
  Layer.mergeAll(AgentSessionRepository.layer, AgentSessionSnapshotReader.layer, stateFabricationLayer),
  Layer.provideMerge(AppDBLiveLayer),
  Layer.provide(ConfigService.layer),
);

async function driveSessionTo(sessionId: string, events: ReadonlyArray<{ type: string }>) {
  const actor = await Effect.runPromise(
    Effect.provide(getOrRestoreActor(sessionId as AgentSessionId), ActorDriverLayer),
  );
  for (const event of events) {
    actor.send(event as any);
  }
  // Let the snapshot-persistence subscriber's forked write land, so
  // session.status (read by requireOwnedSession/the debug endpoint) is
  // consistent with the actor's new in-memory value.
  await new Promise((r) => setTimeout(r, 100));
}

async function ensureBucket() {
  try {
    await makeS3Client().send(new CreateBucketCommand({ Bucket: process.env.S3_BUCKET! }));
  } catch {
    // bucket already exists
  }
}

function makeS3Client() {
  return new S3Client({
    endpoint: process.env.S3_ENDPOINT!,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY!,
      secretAccessKey: process.env.S3_SECRET_KEY!,
    },
    forcePathStyle: true,
    region: "us-east-1",
  });
}

async function putObjectToS3(key: string, content: string) {
  await makeS3Client().send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET!,
      Key: key,
      Body: Buffer.from(content),
      ContentType: "text/plain",
    }),
  );
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const createdSessionIds: string[] = [];

afterAll(async () => {
  for (const id of createdSessionIds) {
    await runDb(Effect.flatMap(AgentSessionRepository, (db) => db.deleteAgentSession(id as AgentSessionId)));
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/sessions/upload-url", () => {
  it("returns 400 when files array is empty", async () => {
    const res = await post("/api/sessions/upload-url", { files: [] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when sizeBytes exceeds 100MB", async () => {
    const res = await post("/api/sessions/upload-url", {
      files: [
        {
          filename: "large.txt",
          mimeType: "text/plain",
          sizeBytes: 100_000_001,
        },
      ],
    });
    expect(res.status).toBe(400);
  });

  it("returns sessionId and presignedUrl for valid request", async () => {
    const res = await post("/api/sessions/upload-url", {
      files: [
        {
          filename: "brief.txt",
          mimeType: "text/plain",
          sizeBytes: 1000,
        },
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("sessionId");
    expect(body.uploads).toHaveLength(1);
    expect(body.uploads[0]).toHaveProperty("presignedUrl");
    expect(body.uploads[0]).toHaveProperty("s3Key");
    expect(body.uploads[0]).toHaveProperty("documentId");

    createdSessionIds.push(body.sessionId);
  });

  it("creates a session record in the DB", async () => {
    const res = await post("/api/sessions/upload-url", {
      files: [
        {
          filename: "test.txt",
          mimeType: "text/plain",
          sizeBytes: 500,
        },
      ],
    });

    const body = await res.json();
    createdSessionIds.push(body.sessionId);

    const sessionOpt = await runDb(
      Effect.flatMap(AgentSessionRepository, (db) => db.getAgentSessionById({ sessionId: body.sessionId })),
    );

    expect(Option.isSome(sessionOpt)).toBe(true);
    const session = Option.getOrThrow(sessionOpt);
    expect(session.status).toBe("uploading");
  });

  it("creates document records in the DB", async () => {
    const res = await post("/api/sessions/upload-url", {
      files: [
        {
          filename: "doc1.txt",
          mimeType: "text/plain",
          sizeBytes: 500,
        },
        {
          filename: "doc2.txt",
          mimeType: "text/plain",
          sizeBytes: 500,
        },
      ],
    });

    const body = await res.json();
    createdSessionIds.push(body.sessionId);

    const docs = await runDb(
      Effect.flatMap(DocumentRepository, (db) => db.getDocumentsBySessionId(body.sessionId)),
    );

    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.filename)).toContain("doc1.txt");
    expect(docs.map((d) => d.filename)).toContain("doc2.txt");
  });
});

describe("POST /api/sessions/:id/confirm-upload", () => {
  it("returns 400 when s3Key does not exist in S3", async () => {
    const uploadRes = await post("/api/sessions/upload-url", {
      files: [
        {
          filename: "missing.txt",
          mimeType: "text/plain",
          sizeBytes: 100,
        },
      ],
    });
    const { sessionId, uploads } = await uploadRes.json();
    createdSessionIds.push(sessionId);

    const res = await post(`/api/sessions/${sessionId}/confirm-upload`, {
      uploads: [{ s3Key: uploads[0].s3Key, documentId: uploads[0].documentId }],
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty("missingKeys");
  });

  it("returns 200 with valid:true when s3Key exists in S3", async () => {
    await ensureBucket();

    const uploadRes = await post("/api/sessions/upload-url", {
      files: [
        {
          filename: "present.txt",
          mimeType: "text/plain",
          sizeBytes: 100,
        },
      ],
    });
    const { sessionId, uploads } = await uploadRes.json();
    createdSessionIds.push(sessionId);

    await putObjectToS3(uploads[0].s3Key, "Hello world this is a test document.");

    const res = await post(`/api/sessions/${sessionId}/confirm-upload`, {
      uploads: [{ s3Key: uploads[0].s3Key, documentId: uploads[0].documentId }],
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
  });

  it("after confirm, chunks are created with embeddings", async () => {
    await ensureBucket();

    const content =
      "The system shall allow users to upload documents. The system shall process PDF files. The system shall extract text from uploaded documents and store them in a searchable format.";

    const uploadRes = await post("/api/sessions/upload-url", {
      files: [
        {
          filename: "requirements.txt",
          mimeType: "text/plain",
          sizeBytes: Buffer.byteLength(content),
        },
      ],
    });
    const { sessionId, uploads } = await uploadRes.json();
    createdSessionIds.push(sessionId);

    await putObjectToS3(uploads[0].s3Key, content);

    await post(`/api/sessions/${sessionId}/confirm-upload`, {
      uploads: [{ s3Key: uploads[0].s3Key, documentId: uploads[0].documentId }],
    });

    // Wait for async processing (forkDetach)
    await new Promise((resolve) => setTimeout(resolve, 8000));

    const sessionChunks = await runDb(
      Effect.flatMap(ChunkRepository, (db) => db.getChunksBySessionId(sessionId)),
    );

    expect(sessionChunks.length).toBeGreaterThan(0);
    expect(sessionChunks.every((c) => c.embedding !== null)).toBe(true);
    expect(sessionChunks.every((c) => c.content.length > 0)).toBe(true);
  }, 20000);

  it("after confirm, token count is stored on document", async () => {
    await ensureBucket();

    const content = "This is a test document with some content for token counting purposes.";

    const uploadRes = await post("/api/sessions/upload-url", {
      files: [
        {
          filename: "tokens.txt",
          mimeType: "text/plain",
          sizeBytes: Buffer.byteLength(content),
        },
      ],
    });
    const { sessionId, uploads } = await uploadRes.json();
    createdSessionIds.push(sessionId);

    await putObjectToS3(uploads[0].s3Key, content);

    await post(`/api/sessions/${sessionId}/confirm-upload`, {
      uploads: [{ s3Key: uploads[0].s3Key, documentId: uploads[0].documentId }],
    });

    // Wait for async processing (forkDetach)
    await new Promise((resolve) => setTimeout(resolve, 8000));

    const docs = await runDb(
      Effect.flatMap(DocumentRepository, (db) => db.getDocumentsBySessionId(sessionId)),
    );

    expect(docs[0]?.tokenCount).toBeGreaterThan(0);
  }, 20000);
});

describe("POST /api/sessions/:id/documents/upload-url (SHIP-180)", () => {
  it("returns 404 for another user's session", async () => {
    const ownerId = await createTestUser(`owner-${randomUUID()}@shipwright.local`);
    const ownerCookie = createAuthCookie(ownerId);
    const attackerId = await createTestUser(`attacker-${randomUUID()}@shipwright.local`);
    const attackerCookie = createAuthCookie(attackerId);

    const uploadRes = await postAuthed(
      "/api/sessions/upload-url",
      { files: [{ filename: "owner-doc.txt", mimeType: "text/plain", sizeBytes: 100 }] },
      ownerCookie,
    );
    const { sessionId } = await uploadRes.json();
    createdSessionIds.push(sessionId);

    const res = await postAuthed(
      `/api/sessions/${sessionId}/documents/upload-url`,
      { files: [{ filename: "intruder.txt", mimeType: "text/plain", sizeBytes: 100 }] },
      attackerCookie,
    );

    expect(res.status).toBe(404);
  });

  it("rejects with 409 SessionStateError for a busy pipeline state (summarizing)", async () => {
    const userId = await createTestUser(`busy-${randomUUID()}@shipwright.local`);
    const cookie = createAuthCookie(userId);

    const uploadRes = await postAuthed(
      "/api/sessions/upload-url",
      { files: [{ filename: "a.txt", mimeType: "text/plain", sizeBytes: 100 }] },
      cookie,
    );
    const { sessionId } = await uploadRes.json();
    createdSessionIds.push(sessionId);

    // idle -> uploading -> uploading_docs_ready -> summarizing, via the
    // machine's own real (zero-payload) events — see driveSessionTo's doc
    // comment above for why this beats a fabricated snapshot. `summarizing`
    // is not idle/uploading/complete, so it stands in for any busy state.
    await driveSessionTo(sessionId, [
      { type: "UPLOAD_COMPLETE" },
      { type: "DOCUMENTS_READY" },
      { type: "USER_CONFIRM" },
    ]);

    const res = await postAuthed(
      `/api/sessions/${sessionId}/documents/upload-url`,
      { files: [{ filename: "b.txt", mimeType: "text/plain", sizeBytes: 100 }] },
      cookie,
    );

    expect(res.status).toBe(409);
  });

  it("accepts a freshly created session (idle)", async () => {
    // uploading/complete acceptance is already covered, without hitting the
    // Postgres-round-trip bug noted above, by agent-session-aggregate.test.ts's
    // it.each(["idle","uploading","complete"]) against requireSessionAcceptsDocuments
    // directly. This proves the HTTP handler wires into that same guard.
    const userId = await createTestUser(`accepts-${randomUUID()}@shipwright.local`);
    const cookie = createAuthCookie(userId);

    const uploadRes = await postAuthed(
      "/api/sessions/upload-url",
      { files: [{ filename: "a.txt", mimeType: "text/plain", sizeBytes: 100 }] },
      cookie,
    );
    const { sessionId } = await uploadRes.json();
    createdSessionIds.push(sessionId);

    const res = await postAuthed(
      `/api/sessions/${sessionId}/documents/upload-url`,
      { files: [{ filename: "b.txt", mimeType: "text/plain", sizeBytes: 100 }] },
      cookie,
    );

    expect(res.status).toBe(200);
  });
});

describe("GET /api/sessions/:id", () => {
  it("returns 404 for unknown session id", async () => {
    const res = await get("/api/sessions/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("returns session data for existing session", async () => {
    const uploadRes = await post("/api/sessions/upload-url", {
      files: [
        {
          filename: "session-test.txt",
          mimeType: "text/plain",
          sizeBytes: 100,
        },
      ],
    });
    const { sessionId } = await uploadRes.json();
    createdSessionIds.push(sessionId);

    const res = await get(`/api/sessions/${sessionId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("id", sessionId);
    expect(body).toHaveProperty("status", "uploading");
    expect(body).toHaveProperty("createdAt");
  });
});

describe("GET /api/health", () => {
  it("returns 200 Healthy", async () => {
    const res = await get("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBe({ status: "ok", version: "0.0.0" });
  });
});
