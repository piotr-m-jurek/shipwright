import { Effect, Option, pipe } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { AgentSessionNotFound, ConfirmAnalysisError } from "@shipwright/shared/domain/errors";
import { MessageQueue } from "@shipwright/queue";
import { AgentSessionAggregate } from "../../agent/agent-session-aggregate";
import {
  GetAgentSessionResponse,
  ConfirmAnalysisResponse,
  GetSessionDebugResponse,
  GetSessionDocumentsResponse,
} from "@shipwright/shared/schemas/api";
import { Api } from "@shipwright/shared/api";
import { AgentSessionRepository } from "@shipwright/db/repositories/agent-session-repository";
import { AgentSessionSnapshotReader } from "@shipwright/db/repositories/agent-session-snapshot-reader";
import { DocumentRepository } from "@shipwright/db/repositories/document-repository";
import { ClarificationRepository } from "@shipwright/db/repositories/clarification-repository";
import { OutputRepository } from "@shipwright/db/repositories/output-repository";
import { CurrentUser } from "@shipwright/shared/middleware";
import type { Question } from "@shipwright/shared/domain/types";
import { publishForCurrentState } from "../../agent/session-process-manager";

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
        const snapshotReader = yield* AgentSessionSnapshotReader;
        const documentDb = yield* DocumentRepository;
        const clarificationDb = yield* ClarificationRepository;
        const outputDb = yield* OutputRepository;
        const messageQueue = yield* MessageQueue;
        const user = yield* CurrentUser;

        // Ownership check — 404 for unknown or other user's session
        const session = yield* snapshotReader
          .get({ sessionId, userId: user.id })
          .pipe(
            Effect.orDie,
            Effect.flatMap(Effect.fromOption),
            Effect.catchTag("NoSuchElementError", () => new AgentSessionNotFound()),
          );

        const queueRows = yield* messageQueue.listBySession(sessionId);

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
        const agentSessionDb = yield* AgentSessionRepository;
        const aggregate = yield* AgentSessionAggregate;
        const user = yield* CurrentUser;

        // Ownership check — 404 for unknown or other user's session
        yield* pipe(
          agentSessionDb.getAgentSessionByIdForUser({ sessionId, userId: user.id }),
          Effect.map((v) => Option.getOrThrow(v)),
          Effect.catch(() => new AgentSessionNotFound()),
        );

        // confirmUpload is idempotent — None means a prior call already
        // confirmed this session (nothing changed, nothing new to publish).
        // Publish session.workflow only if the machine actually transitioned
        // and is now in summarizing. If it entered waiting_for_documents
        // instead, processUploadedDocuments will publish session.workflow
        // after sending DOCUMENTS_READY.
        yield* pipe(
          aggregate.confirmUpload(sessionId),
          Effect.mapError((cause) => new ConfirmAnalysisError({ cause })),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (state) => publishForCurrentState(sessionId, state),
            }),
          ),
        );

        return new ConfirmAnalysisResponse({ started: true });
      }),
    ),
);
