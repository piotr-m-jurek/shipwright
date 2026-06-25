import { describe, it, expect, afterAll, vi } from "vitest";
import { Layer, pipe } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { NodeHttpServer } from "@effect/platform-node";
import { S3Client, PutObjectCommand, CreateBucketCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentSessions, chunks, documents } from "../db/schema.js";
import { config } from "../config.js";
import { ConfigService } from "../config.js";
import { StorageAdapter } from "../storage/index.js";
import { ApiRoute } from "./server.js";
import { DatabaseService } from "../db/queries.js";

// ---------------------------------------------------------------------------
// Embedder mock
// ---------------------------------------------------------------------------

vi.mock("../agent/embedder.js", async () => {
  const { Effect } = await import("effect");
  return {
    embedChunks: (chunks: string[]) => Effect.succeed(chunks.map(() => Array(1536).fill(0.1))),
  };
});

// ---------------------------------------------------------------------------
// Test handler setup
// ---------------------------------------------------------------------------

// Build the same route layer as the server but without NodeHttpServer or
// StaticFiles — those are not needed for API tests.
// HttpRouter.toWebHandler provides HttpServer internally; we supply the
// platform services (FileSystem, Path, HttpPlatform, Etag.Generator) via
// NodeHttpServer.layerHttpServices.
const TestRoutes = pipe(
  ApiRoute,
  Layer.provide(NodeHttpServer.layerHttpServices),
  Layer.provide(StorageAdapter.layer),
  Layer.provide(DatabaseService.layer),
  Layer.provide(ConfigService.layer),
);

const { handler, dispose } = HttpRouter.toWebHandler(TestRoutes, {
  disableLogger: true,
});

afterAll(() => dispose());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    await makeS3Client().send(new CreateBucketCommand({ Bucket: config.storage.bucket }));
  } catch {
    // bucket already exists
  }
}

function makeS3Client() {
  return new S3Client({
    endpoint: config.storage.endpoint,
    credentials: {
      accessKeyId: config.storage.accessKey,
      secretAccessKey: config.storage.secretKey,
    },
    forcePathStyle: true,
    region: "us-east-1",
  });
}

async function putObjectToS3(key: string, content: string) {
  await makeS3Client().send(
    new PutObjectCommand({
      Bucket: config.storage.bucket,
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
    await db.delete(agentSessions).where(eq(agentSessions.id, id));
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
          documentType: "notes",
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
          documentType: "notes",
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
          documentType: "transcript",
          mimeType: "text/plain",
          sizeBytes: 500,
        },
      ],
    });

    const body = await res.json();
    createdSessionIds.push(body.sessionId);

    const [session] = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, body.sessionId));

    expect(session).toBeDefined();
    expect(session.status).toBe("uploading");
  });

  it("creates document records in the DB", async () => {
    const res = await post("/api/sessions/upload-url", {
      files: [
        {
          filename: "doc1.txt",
          documentType: "prd_draft",
          mimeType: "text/plain",
          sizeBytes: 500,
        },
        {
          filename: "doc2.txt",
          documentType: "rfp",
          mimeType: "text/plain",
          sizeBytes: 500,
        },
      ],
    });

    const body = await res.json();
    createdSessionIds.push(body.sessionId);

    const docs = await db.select().from(documents).where(eq(documents.sessionId, body.sessionId));

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
          documentType: "notes",
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
          documentType: "notes",
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
          documentType: "prd_draft",
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

    const sessionChunks = await db.select().from(chunks).where(eq(chunks.sessionId, sessionId));

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
          documentType: "notes",
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

    const [doc] = await db.select().from(documents).where(eq(documents.sessionId, sessionId));

    expect(doc.tokenCount).toBeGreaterThan(0);
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
          documentType: "notes",
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
    expect(body).toBe("Healthy");
  });
});
