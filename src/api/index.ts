import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { createUploadSession } from "../agent/create-upload-session.js";
import { ConfirmUploadRequestSchema, CreateSessionRequestSchema } from "../shared/schemas/api.js";
import { runtime } from "../runtime.js";
import { confirmUploadResults } from "../agent/confirm-upload-results.js";
import { processUploadedDocuments } from "../agent/process-uploaded-documents.js";

const api = new Hono();

api.post("/sessions/upload-url", zValidator("json", CreateSessionRequestSchema), async (c) => {
  const { files } = c.req.valid("json");
  const result = await runtime.runPromise(createUploadSession(files));
  return c.json(result);
});

api.post(
  "/sessions/:sessionId/confirm-upload",
  zValidator("json", ConfirmUploadRequestSchema),
  async (c) => {
    const { uploads } = c.req.valid("json");
    const sessionId = c.req.param("sessionId");

    const results = await runtime.runPromise(confirmUploadResults(uploads));

    const missingKeys = results.filter((r) => !r.exists).map((r) => r.s3Key);
    if (missingKeys.length > 0) {
      throw new HTTPException(400, {
        res: new Response(JSON.stringify({ error: "Keys do not exist", missingKeys }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      });
    }

    await runtime.runPromise(processUploadedDocuments({ sessionId, uploads })).catch((error) => {
      // Effect errors that escaped — log them
      console.error("[confirm-upload] processUploadedDocuments failed:", error);
    });

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
