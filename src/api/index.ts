import { Hono } from "hono";

const api = new Hono();

api.post("/sessions", (c) => {
  // INFO: Document upload
  return c.text("Created Session");
});

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
