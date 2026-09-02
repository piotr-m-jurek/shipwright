/**
 * effect-mq job definitions (SHIP-109) — one per queue name from the old
 * hand-rolled MessageQueue, same names for continuity.
 *
 * idempotencyKey design note: `Job`'s idempotencyKey derives a *permanent*
 * job id from the payload — "when a job with this id already exists (in any
 * state — including completed), the request is a no-op" (effect-mq's own
 * JobStore docs), not just while pending like `dedupe`. That makes a bare
 * `sessionId` key unsafe for sessionWorkflow/sessionGenerate/sessionRevise:
 * a session can legitimately go through generation more than once (a
 * revision is a second, later `session.revise`/`session.generate` for the
 * same session) — keying solely on sessionId would silently no-op the
 * second revision once the first request's job row exists. Embedding the
 * target output version would fix that, but the version is computed by the
 * pipeline at run time (see generation.ts's SHIP-149 change), not known at
 * enqueue time — embedding it here would race against that computation.
 * So these three rely on effect-mq's attempts/backoff for in-flight retry
 * safety (a worker crash mid-handler retries the SAME job row, not a new
 * enqueue) rather than a payload-derived idempotencyKey.
 *
 * documentsProcess is different: its payload already carries stable,
 * meaningful identity (which documents), so a key scoped to that payload is
 * safe — a re-publish for the exact same document set (e.g. retry-session.ts
 * retrying the same failed uploads) is correctly one job; a different
 * document set is correctly a different one.
 */
import { Job } from "effect-mq";
import { AgentSessionId } from "@shipwright/shared/domain/ids";
import { ConfirmUploadRequest } from "@shipwright/shared/schemas";

export class DocumentsProcess extends Job.make("documents.process", {
  payload: {
    sessionId: AgentSessionId,
    uploads: ConfirmUploadRequest.fields.uploads,
  },
  queue: "documents.process",
  idempotencyKey: ({ sessionId, uploads }) =>
    `${sessionId}:${uploads
      .map((u) => u.documentId)
      .toSorted()
      .join(",")}`,
  metadata: ({ sessionId }) => ({ sessionId }),
  defaults: { attempts: 3, backoff: { type: "exponential", delay: "5 seconds" } },
}) {}

export class SessionWorkflow extends Job.make("session.workflow", {
  payload: { sessionId: AgentSessionId },
  queue: "session.workflow",
  metadata: ({ sessionId }) => ({ sessionId }),
  defaults: { attempts: 5, backoff: { type: "exponential", delay: "5 seconds" } },
}) {}

export class SessionGenerate extends Job.make("session.generate", {
  payload: { sessionId: AgentSessionId },
  queue: "session.generate",
  metadata: ({ sessionId }) => ({ sessionId }),
  defaults: { attempts: 3, backoff: { type: "exponential", delay: "5 seconds" } },
}) {}

export class SessionRevise extends Job.make("session.revise", {
  payload: { sessionId: AgentSessionId },
  queue: "session.revise",
  metadata: ({ sessionId }) => ({ sessionId }),
  defaults: { attempts: 3, backoff: { type: "exponential", delay: "5 seconds" } },
}) {}
