import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { S3Storage } from "../storage/index.js";
import pLimit from "p-limit";
import { processUploadedDocuments } from "../agent/process-uploaded-documents.js";
import { createUploadSession } from "../agent/create-upload-session.js";
import {
  ConfirmUploadRequestSchema,
  CreateSessionRequestSchema,
} from "../shared/schemas/sessions.js";

const api = new Hono();
const storageAdapter = new S3Storage();

api.post("/sessions/upload-url", zValidator("json", CreateSessionRequestSchema), async (c) => {
  const { files } = c.req.valid("json");
  const result = await createUploadSession({ files, storageAdapter });
  return c.json(result);
});

api.post(
  "/sessions/:sessionId/confirm-upload",
  zValidator("json", ConfirmUploadRequestSchema),
  async (c) => {
    const { uploads } = c.req.valid("json");
    const sessionId = c.req.param("sessionId");

    const limit = pLimit(10);
    const results = await Promise.all(
      uploads.map(({ s3Key }) =>
        limit(async () => ({ s3Key, exists: await storageAdapter.headObject(s3Key) })),
      ),
    );

    const missingKeys = results.filter((r) => !r.exists).map((r) => r.s3Key);
    if (missingKeys.length > 0) {
      throw new HTTPException(400, {
        res: new Response(JSON.stringify({ error: "Keys do not exist", missingKeys }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      });
    }

    processUploadedDocuments({ sessionId, uploads, storageAdapter });
    // TODO: Consider queues, so we don't block the endpoint.
    // For now "don't await" is the good practice, but we don't handle the errors. that's why we need queues

    return c.json({ valid: true }, 202);
  },
);

api.get("/sessions/:id", (c) => {
  const sessionId = c.req.param("id");
  return c.text(`Get session ${sessionId}`);
});

api.post("/sessions/:id/stream", (c) => {
  const _sessionId = c.req.param("id");
  return c.text("trigger analysis, stream progress + questions");
});

api.post("/sessions/:id/answers", (c) => {
  const _sessionId = c.req.param("id");
  return c.text("submit clarifying answers");
});

api.get("/sessions/:id/output", (c) => {
  const _sessionId = c.req.param("id");
  return c.text("stream the two output documents");
});

export { api };
