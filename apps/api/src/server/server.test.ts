import { describe, it, expect, afterAll, vi } from "vitest";
import { Effect, Layer, Option, pipe } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { NodeHttpServer } from "@effect/platform-node";
import { S3Client, PutObjectCommand, CreateBucketCommand } from "@aws-sdk/client-s3";
import { ConfigService } from "@shipwright/config";
import { StorageAdapter } from "../storage/index";
import { ApiLayer } from "./server";
import { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";
import { DocumentRepository } from "@shipwright/db/repositories/document-repository";
import { ChunkRepository } from "@shipwright/db/repositories/chunk-repository";
import { AppDBLiveLayer } from "@shipwright/db";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";

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
// Helpers
// ---------------------------------------------------------------------------

function runDb<A>(effect: Effect.Effect<A, unknown, AgentSessionRepository | DocumentRepository | ChunkRepository>) {
  return Effect.runPromise(Effect.provide(effect, DbLayer));
}

async function post(path: string, body: unknown) {
  return handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function get(path: string) {
  return handler(new Request(`http://localhost${path}`));
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
