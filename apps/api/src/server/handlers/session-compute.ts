import { Effect, Option, pipe } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { AgentSessionNotFound, ConfirmAnalysisError } from "@shipwright/shared/domain/errors.js";
import { getOrRestoreActor } from "../../agent/session-actor.ts";
import {
  GetAgentSessionResponse,
  ConfirmAnalysisResponse,
} from "@shipwright/shared/schemas/api.js";
import { Api } from "@shipwright/shared/api.js";
import { DbAgentSession } from "../../db/services/agent-session.ts";
import { DbClarification } from "../../db/services/clarification.ts";
import { CurrentUser } from "@shipwright/shared/middleware.js";
import { MessageQueue } from "../../queue/index.ts";
import { QuestionSelect } from "../../db/types.ts";

export const SessionCompute = HttpApiBuilder.group(Api, "compute", (handlers) =>
  handlers
    .handle("getAgentSessionById", ({ params: { sessionId } }) =>
      Effect.gen(function* () {
        const agentSessionDb = yield* DbAgentSession;
        const clarificationDb = yield* DbClarification;
        const user = yield* CurrentUser;

        const session = yield* agentSessionDb.getAgentSessionByIdForUser({ sessionId, userId: user.id }).pipe(
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail(new AgentSessionNotFound()),
            onSome: Effect.succeed,
          })),
        );

        // Include current questions when session is awaiting answers
        const questions = yield* clarificationDb.getQuestionsBySessionId(sessionId).pipe(
          Effect.when(Effect.succeed(session.status === "awaiting_answers")),
          Effect.mapError(() => new AgentSessionNotFound()),
          Effect.map(Option.getOrElse(() => [] as QuestionSelect[])),
        );

        return new GetAgentSessionResponse({
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
          return new ConfirmAnalysisResponse({ started: true });
        }

        actor.send({ type: "UPLOAD_COMPLETE" });
        yield* mq.publish("session.workflow", { sessionId }, { maxAttempts: 5 });
        actor.send({ type: "USER_CONFIRM" }); // uploading → summarizing

        return new ConfirmAnalysisResponse({ started: true });
      }),
    ),
);
