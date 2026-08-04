import { Effect, Option, pipe } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  AgentSessionNotFound,
  AnalysisPipelineError,
  RevisionError,
  SessionStateError,
} from "@shipwright/shared/domain/errors.js";
import {
  PostAgentSessionAnswersResponse,
  GetAgentSessionFinalOutputResponse,
  ReviseResponse,
} from "@shipwright/shared/schemas/api.js";
import { Api } from "@shipwright/shared/api.js";
import { DbAgentSession } from "../../db/services/agent-session.ts";
import { DbOutput } from "../../db/services/output.ts";
import { CurrentUser } from "@shipwright/shared/middleware.js";
import { submitAnswers } from "../../agent/pipelines/submit-answers.js";
import { startRevision } from "../../agent/pipelines/generation.js";
import { SessionStateError as ActorSessionStateError } from "../../agent/errors.js";

export const SessionResults = HttpApiBuilder.group(Api, "results", (handlers) =>
  handlers
    .handle("submitSessionAnswers", ({ payload: { answers }, params: { sessionId } }) =>
      Effect.gen(function* () {
        const result = yield* pipe(
          submitAnswers(sessionId, [...answers]),
          Effect.mapError(() => new AnalysisPipelineError()),
        );
        return new PostAgentSessionAnswersResponse({
          sufficient: result.sufficient,
          round: result.round,
        });
      }),
    )
    .handle("getSessionFinalOutput", ({ params: { sessionId } }) =>
      Effect.gen(function* () {
        const agentSessionDb = yield* DbAgentSession;
        const outputDb = yield* DbOutput;
        const user = yield* CurrentUser;

        yield* agentSessionDb.getAgentSessionByIdForUser({ sessionId, userId: user.id }).pipe(
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail(new AgentSessionNotFound()),
            onSome: Effect.succeed,
          })),
        );

        const allOutputs = yield* pipe(
          outputDb.getOutputsBySessionId(sessionId),
          Effect.mapError(() => new AgentSessionNotFound()),
        );

        const brief = allOutputs.find((o) => o.type === "project_brief");
        const prd = allOutputs.find((o) => o.type === "implementation_prd");

        return new GetAgentSessionFinalOutputResponse({
          projectBrief: brief?.content ?? null,
          implementationPrd: prd?.content ?? null,
          version: brief?.version ?? null,
        });
      }),
    )
    .handle("reviseOutput", ({ payload: { feedback }, params: { sessionId } }) =>
      Effect.gen(function* () {
        const result = yield* pipe(
          startRevision(sessionId, feedback),
          Effect.mapError((e) => {
            if (e instanceof ActorSessionStateError) {
              return new SessionStateError({ message: e.message });
            }
            return new RevisionError();
          }),
        );
        return new ReviseResponse({ started: result.started });
      }),
    ),
);
