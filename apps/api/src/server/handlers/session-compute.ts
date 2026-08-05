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
import type { Question } from "@shipwright/shared/domain/types";

export const SessionCompute = HttpApiBuilder.group(Api, "compute", (handlers) =>
  handlers
    .handle("getAgentSessionById", ({ params: { sessionId } }) =>
      Effect.gen(function* () {
        const agentSessionDb = yield* DbAgentSession;
        const clarificationDb = yield* DbClarification;
        const user = yield* CurrentUser;

        const session = yield* agentSessionDb.getAgentSessionByIdForUser({ sessionId, userId: user.id }).pipe(
          Effect.mapError(() => new AgentSessionNotFound()),
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail(new AgentSessionNotFound()),
            onSome: Effect.succeed,
          })),
        );

        // Include current questions when session is awaiting answers
        const questions = yield* clarificationDb.getQuestionsBySessionId(sessionId).pipe(
          Effect.mapError(() => new AgentSessionNotFound()),
          Effect.when(Effect.succeed(session.status === "awaiting_answers")),
          Effect.map(Option.getOrElse(() => [] as Question[])),
        );

        return new GetAgentSessionResponse({
          id: session.id,
          createdAt: session.createdAt,
          status: session.status,
          inputMode: session.inputMode,
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
        const actor = yield* pipe(
          getOrRestoreActor(sessionId),
          Effect.mapError(() => new ConfirmAnalysisError()),
        );

        const state = actor.getSnapshot();

        if (state.value !== "idle") {
          return new ConfirmAnalysisResponse({ started: true });
        }

        // Advance the actor: idle → uploading → summarizing.
        // The actual session.workflow job is published by the documents.process
        // consumer after chunks are written, ensuring no race between chunking
        // and summarisation.
        actor.send({ type: "UPLOAD_COMPLETE" });
        actor.send({ type: "USER_CONFIRM" });

        return new ConfirmAnalysisResponse({ started: true });
      }),
    ),
);
