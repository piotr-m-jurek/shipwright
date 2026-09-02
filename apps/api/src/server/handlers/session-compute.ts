import { Effect, Option, pipe } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  AgentSessionNotFound,
  ConfirmAnalysisError,
  JobNotFoundError,
  JobNotRetryableError,
  ServiceUnavailableError,
} from "@shipwright/shared/domain/errors";
import { JobStore } from "effect-mq";
import { AgentSessionAggregate } from "../../agent/agent-session-aggregate";
import { toServiceUnavailable } from "./service-unavailable";
import { requireOwnedSession } from "./require-owned-session";
import {
  GetAgentSessionResponse,
  ConfirmAnalysisResponse,
  GetSessionDebugResponse,
  GetSessionDocumentsResponse,
  RetryJobResponse,
} from "@shipwright/shared/schemas/api";
import { Api } from "@shipwright/shared/api";
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
        const clarificationDb = yield* ClarificationRepository;
        const user = yield* CurrentUser;

        const session = yield* requireOwnedSession(sessionId, user.id);

        // Include current questions when session is awaiting answers
        const questions = yield* pipe(
          clarificationDb.getQuestionsBySessionId(sessionId),
          Effect.when(Effect.succeed(session.status === "awaiting_answers")),
          Effect.map(Option.getOrElse(() => [] as Question[])),
          toServiceUnavailable,
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
        const documentDb = yield* DocumentRepository;
        const user = yield* CurrentUser;

        yield* requireOwnedSession(sessionId, user.id);

        const documents = yield* documentDb
          .getDocumentsBySessionId(sessionId)
          .pipe(toServiceUnavailable);

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
        const jobStore = yield* JobStore.JobStore;
        const user = yield* CurrentUser;

        // Ownership check — 404 for unknown or other user's session
        const session = yield* snapshotReader
          .get({ sessionId, userId: user.id })
          .pipe(
            toServiceUnavailable,
            Effect.flatMap(Effect.fromOption),
            Effect.catchTag("NoSuchElementError", () => new AgentSessionNotFound()),
          );

        // effect-mq metadata filter across all four job types — every
        // Job.make definition in packages/queue/src/jobs.ts sets
        // metadata: ({ sessionId }) => ({ sessionId }).
        const { items: queueJobs } = yield* jobStore
          .list({ metadata: { sessionId } })
          .pipe(toServiceUnavailable);

        const documents = yield* documentDb
          .getDocumentsBySessionId(sessionId)
          .pipe(toServiceUnavailable);
        const questions = yield* clarificationDb
          .getQuestionsBySessionId(sessionId)
          .pipe(toServiceUnavailable);
        const answers = yield* clarificationDb
          .getAnswersBySessionId(sessionId)
          .pipe(toServiceUnavailable);
        const outputs = yield* outputDb.getOutputsBySessionId(sessionId).pipe(toServiceUnavailable);

        // Extract XState context from snapshot
        const xstate = pipe(
          Option.fromNullishOr(session.xstateSnapshot),
          Option.match({
            onNone: () => null,
            onSome: (snap) => ({
              value: String(session.status),
              round: snap.round ?? 0,
              inputMode: snap.inputMode ?? "context",
              // SHIP-149: outputVersion no longer lives in the snapshot —
              // derived from the outputs table (already fetched above,
              // sorted desc(version)), the single source of truth.
              outputVersion: outputs[0]?.version ?? 0,
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
          queue: queueJobs.map((j) => ({
            id: j.id,
            queue: j.queue,
            status: j.state,
            attempts: j.attemptsMade,
            maxAttempts: j.attemptsMax,
            createdAt: new Date(j.enqueuedAt),
          })),
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
        const aggregate = yield* AgentSessionAggregate;
        const user = yield* CurrentUser;

        // Ownership check — 404 for unknown/other-user session, 503 if the
        // store itself failed.
        yield* requireOwnedSession(sessionId, user.id);

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
    )
    .handle("retryJob", ({ params: { sessionId, jobId } }) =>
      Effect.gen(function* () {
        const jobStore = yield* JobStore.JobStore;
        const user = yield* CurrentUser;

        // Ownership check — 404 for unknown/other-user session, 503 if the
        // store itself failed.
        yield* requireOwnedSession(sessionId, user.id);

        // The job must both exist AND belong to this session — jobId is an
        // opaque effect-mq id, not scoped to a session by construction, so
        // this is the ownership check for the job itself (never distinguish
        // "not found" from "found but not yours" — same 404 either way).
        const record = yield* jobStore
          .getJob(JobStore.JobId(jobId))
          .pipe(
            toServiceUnavailable,
            Effect.flatMap(Effect.fromOption),
            Effect.catchTag("NoSuchElementError", () => new JobNotFoundError()),
          );

        if (record.metadata["sessionId"] !== sessionId) {
          return yield* new JobNotFoundError();
        }

        yield* jobStore.retry(record.id).pipe(
          Effect.catchTags({
            // SHIP-178: same reasoning as toServiceUnavailable — a store
            // failure here is a real, typed, temporary condition, not a bug.
            JobStoreError: (cause) =>
              Effect.logError("[retryJob] JobStore.retry failed", cause).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ServiceUnavailableError({
                      message: "A backing service is temporarily unavailable",
                    }),
                  ),
                ),
              ),
            JobNotFoundError: () => new JobNotFoundError(),
            JobNotRetryableError: () => new JobNotRetryableError({ state: record.state }),
          }),
        );

        return new RetryJobResponse({ retried: true });
      }),
    ),
);
