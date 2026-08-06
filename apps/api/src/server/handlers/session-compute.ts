import { Effect, Option, pipe } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { AgentSessionNotFound, ConfirmAnalysisError } from "@shipwright/shared/domain/errors.js";
import { MessageQueue } from "../../queue/index.ts";
import { getOrRestoreActor } from "../../agent/session-actor.ts";
import {
  GetAgentSessionResponse,
  ConfirmAnalysisResponse,
  GetSessionDebugResponse,
  GetSessionDocumentsResponse,
} from "@shipwright/shared/schemas/api.js";
import { Api } from "@shipwright/shared/api.js";
import { AgentSessionRepository } from "../../db/repositories/agent-session-repository.ts";
import { DocumentRepository } from "../../db/repositories/document-repository.ts";
import { ClarificationRepository } from "../../db/repositories/clarification-repository.ts";
import { OutputRepository } from "../../db/repositories/output-repository.ts";
import { CurrentUser } from "@shipwright/shared/middleware.js";
import type { Question } from "@shipwright/shared/domain/types";
import { DB } from "../../db/index.ts";
import { queueMessages } from "../../queue/index.ts";
import { sql } from "drizzle-orm";

export const SessionCompute = HttpApiBuilder.group(Api, "compute", (handlers) =>
  handlers
    .handle("getAgentSessionById", ({ params: { sessionId } }) =>
      Effect.gen(function* () {
        const agentSessionDb = yield* AgentSessionRepository;
        const clarificationDb = yield* ClarificationRepository;
        const user = yield* CurrentUser;

        const session = yield* pipe(
          agentSessionDb.getAgentSessionByIdForUser({ sessionId, userId: user.id }),
          Effect.map((v) => Option.getOrThrow(v)),
          Effect.catch(() => new AgentSessionNotFound()),
        );

        // Include current questions when session is awaiting answers
        const questions = yield* pipe(
          clarificationDb.getQuestionsBySessionId(sessionId),
          Effect.when(Effect.succeed(session.status === "awaiting_answers")),
          Effect.map(Option.getOrElse(() => [] as Question[])),
          Effect.mapError(() => new AgentSessionNotFound()),
        );

        return new GetAgentSessionResponse({
          id: session.id,
          createdAt: session.createdAt,
          status: session.status,
          inputMode: session.inputMode,
          errorReason: session.errorReason ?? null,
          questions: questions.map((q) => ({
            id: q.id,
            text: q.text,
            rationale: q.rationale,
            sourceDocuments: q.sourceDocuments,
            orderIndex: q.orderIndex,
          })),
        });
      }),
    )
    .handle("getSessionDocuments", ({ params: { sessionId } }) =>
      Effect.gen(function* () {
        const agentSessionDb = yield* AgentSessionRepository;
        const documentDb = yield* DocumentRepository;
        const user = yield* CurrentUser;

        yield* pipe(
          agentSessionDb.getAgentSessionByIdForUser({ sessionId, userId: user.id }),
          Effect.flatMap(Effect.fromOption),
          Effect.catch(() => new AgentSessionNotFound()),
        );

        const documents = yield* documentDb.getDocumentsBySessionId(sessionId).pipe(Effect.orDie);

        return new GetSessionDocumentsResponse({
          documents: documents.map((d) => ({
            id: d.id,
            filename: d.filename,
            mimeType: d.mimeType,
            sizeBytes: d.sizeBytes,
            status: d.status,
          })),
        });
      }),
    )
    .handle("getSessionDebug", ({ params: { sessionId } }) =>
      Effect.gen(function* () {
        const agentSessionDb = yield* AgentSessionRepository;
        const documentDb = yield* DocumentRepository;
        const clarificationDb = yield* ClarificationRepository;
        const outputDb = yield* OutputRepository;
        const db = yield* DB;
        const user = yield* CurrentUser;

        // Ownership check — 404 for unknown or other user's session
        const session = yield* agentSessionDb
          .getAgentSessionByIdForUser({ sessionId, userId: user.id })
          .pipe(
            Effect.orDie,
            Effect.flatMap(Effect.fromOption),
            Effect.catchTag("NoSuchElementError", () => new AgentSessionNotFound()),
          );

        // Queue messages — filter by sessionId inside JSONB payload
        const queueRows = yield* db
          .select({
            queue: queueMessages.queue,
            status: queueMessages.status,
            attempts: queueMessages.attempts,
            maxAttempts: queueMessages.maxAttempts,
            createdAt: queueMessages.createdAt,
          })
          .from(queueMessages)
          .where(sql`${queueMessages.payload}->>'sessionId' = ${sessionId}`)
          .orderBy(queueMessages.createdAt)
          .pipe(Effect.orDie);

        const documents = yield* documentDb.getDocumentsBySessionId(sessionId).pipe(Effect.orDie);
        const questions = yield* clarificationDb
          .getQuestionsBySessionId(sessionId)
          .pipe(Effect.orDie);
        const answers = yield* clarificationDb.getAnswersBySessionId(sessionId).pipe(Effect.orDie);
        const outputs = yield* outputDb.getOutputsBySessionId(sessionId).pipe(Effect.orDie);

        // Extract XState context from snapshot
        const xstate = pipe(
          Option.fromNullishOr(session.xstateSnapshot),
          Option.match({
            onNone: () => null,
            onSome: (snap) => ({
              value: String(session.status),
              round: snap.round ?? 0,
              inputMode: snap.inputMode ?? "context",
              outputVersion: snap.outputVersion ?? 1,
              documentSummaryCount: snap.documentSummaries?.length ?? 0,
              questionCount: snap.questions?.length ?? 0,
              answerCount: snap.answers?.length ?? 0,
              revisionFeedback: Option.getOrNull(snap.revisionFeedback),
              raw: snap as unknown,
            }),
          }),
        );

        return new GetSessionDebugResponse({
          session: {
            id: session.id,
            status: session.status,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          },
          xstate,
          queue: queueRows,
          documents: documents.map((d) => ({
            id: d.id,
            filename: d.filename,
            status: d.status,
            mimeType: d.mimeType,
            sizeBytes: d.sizeBytes,
            tokenCount: d.tokenCount,
          })),
          questions: questions.map((q) => ({
            id: q.id,
            text: q.text,
            orderIndex: q.orderIndex,
          })),
          answers: answers.map((a) => ({
            questionId: a.questionId,
            text: a.text,
            round: a.round,
          })),
          outputs: outputs.map((o) => ({
            type: o.type,
            version: o.version,
            createdAt: o.createdAt,
            contentLength: o.content?.length ?? 0,
          })),
        });
      }),
    )
    .handle("confirmAnalysis", ({ params: { sessionId } }) =>
      Effect.gen(function* () {
        const actor = yield* pipe(
          getOrRestoreActor(sessionId),
          Effect.mapError((cause) => new ConfirmAnalysisError({ cause })),
        );

        const stateValue = actor.getSnapshot().value;

        // Already past uploading — confirm was already processed.
        const isUploading =
          typeof stateValue === "object" && stateValue !== null && "uploading" in stateValue;
        const isIdle = stateValue === "idle";

        if (!isIdle && !isUploading) {
          return new ConfirmAnalysisResponse({ started: true });
        }

        // Advance idle → uploading_pending_docs first if still idle.
        if (isIdle) {
          actor.send({ type: "UPLOAD_COMPLETE" });
        }

        // Send USER_CONFIRM — machine transitions to either:
        //   uploading_docs_ready → summarizing  (docs already ready)
        //   uploading_pending_docs → waiting_for_documents  (docs still processing)
        actor.send({ type: "USER_CONFIRM" });

        // Publish session.workflow only if machine is now in summarizing.
        // If it entered waiting_for_documents instead, processUploadedDocuments
        // will publish session.workflow after sending DOCUMENTS_READY.
        const afterState = actor.getSnapshot().value;
        const isNowSummarizing = afterState === "summarizing";

        if (isNowSummarizing) {
          const mq = yield* MessageQueue.pipe(
            Effect.mapError((cause) => new ConfirmAnalysisError({ cause })),
          );
          yield* mq
            .publish("session.workflow", { sessionId }, { maxAttempts: 5 })
            .pipe(Effect.mapError((cause) => new ConfirmAnalysisError({ cause })));
        }

        return new ConfirmAnalysisResponse({ started: true });
      }),
    ),
);
