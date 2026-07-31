import { Effect, pipe } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { AgentSessionNotFound, ConfirmAnalysisError } from "@shipwright/shared/domain/errors.js";
import { getOrRestoreActor } from "../../agent/session-actor.ts";
import {
  GetAgentSessionResponse,
  GetAgentSessionProgressResponse,
  ConfirmAnalysisResponse,
} from "@shipwright/shared/schemas/api.js";
import { Api } from "@shipwright/shared/api.js";
import { DatabaseService } from "../../db/queries.ts";
import { CurrentUser } from "@shipwright/shared/middleware.js";
import { MessageQueue } from "../../queue/index.ts";

export const SessionCompute = HttpApiBuilder.group(Api, "compute", (handlers) =>
  handlers
    .handle("getAgentSessionById", ({ params: { sessionId } }) =>
      Effect.gen(function* () {
        const db = yield* DatabaseService;
        const user = yield* CurrentUser;

        const session = yield* db.getAgentSesionByIdForUser({ sessionId, userId: user.id }).pipe(
          Effect.mapError(() => new AgentSessionNotFound()),
          Effect.flatMap((s) =>
            s === undefined ? Effect.fail(new AgentSessionNotFound()) : Effect.succeed(s),
          ),
        );

        // Include current questions when session is awaiting answers
        const questions =
          session.status === "awaiting_answers"
            ? yield* db
                .getQuestionsBySessionId(sessionId)
                .pipe(Effect.mapError(() => new AgentSessionNotFound()))
            : [];

        return GetAgentSessionResponse.make({
          id: session.id,
          createdAt: session.createdAt,
          status: session.status,
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
    .handle("confirmAnalysis", ({ params: { sessionId } }) =>
      Effect.gen(function* () {
        const mq = yield* MessageQueue;
        const actor = yield* pipe(
          getOrRestoreActor(sessionId),
          Effect.mapError(() => new ConfirmAnalysisError()),
        );

        const state = actor.getSnapshot();

        if (state.value !== "idle") {
          return ConfirmAnalysisResponse.make({ started: true });
        }

        actor.send({ type: "UPLOAD_COMPLETE" });
        yield* mq.publish("session.workflow", { sessionId }, { maxAttempts: 5 });
        actor.send({ type: "USER_CONFIRM" }); // uploading → summarizing

        return ConfirmAnalysisResponse.make({ started: true });
      }),
    )
    .handle("getSessionProgress", ({ params: { sessionId: _sessionId } }) =>
      // Legacy endpoint — use POST /sessions/:id/confirm instead.
      // Returns current session status for polling.
      // TODO: Remove at some point
      Effect.sync(() => GetAgentSessionProgressResponse.make({ started: true })),
    ),
);
