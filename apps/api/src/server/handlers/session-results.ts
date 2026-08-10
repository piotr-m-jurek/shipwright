import { Effect, Option, pipe } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  AgentSessionNotFound,
  AnalysisPipelineError,
  RevisionError,
  SessionStateError,
} from "@shipwright/shared/domain/errors";
import {
  PostAgentSessionAnswersResponse,
  GetAgentSessionFinalOutputResponse,
  ReviseResponse,
} from "@shipwright/shared/schemas/api";
import { Api } from "@shipwright/shared/api";
import { AgentSessionRepository } from "../../db/repositories/agent-session-repository";
import { OutputRepository } from "../../db/repositories/output-repository";
import { CurrentUser } from "@shipwright/shared/middleware";
import { submitAnswers } from "../../agent/pipelines/submit-answers";
import { startRevision } from "../../agent/pipelines/generation";
import { SessionStateError as ActorSessionStateError } from "../../agent/errors";

export const SessionResults = HttpApiBuilder.group(Api, "results", (handlers) =>
  handlers
    .handle("submitSessionAnswers", ({ payload: { answers }, params: { sessionId } }) =>
      Effect.gen(function* () {
        const result = yield* pipe(
          submitAnswers(sessionId, [...answers]),
          Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
        );
        return new PostAgentSessionAnswersResponse({
          sufficient: result.sufficient,
          round: result.round,
        });
      }),
    )
    .handle("getSessionFinalOutput", ({ params: { sessionId } }) =>
      Effect.gen(function* () {
        const agentSessionDb = yield* AgentSessionRepository;
        const outputDb = yield* OutputRepository;
        const user = yield* CurrentUser;

        yield* agentSessionDb.getAgentSessionByIdForUser({ sessionId, userId: user.id }).pipe(
          Effect.mapError(() => new AgentSessionNotFound()),
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail(new AgentSessionNotFound()),
            onSome: Effect.succeed,
          })),
        );

        const allOutputs = yield* outputDb.getOutputsBySessionId(sessionId).pipe(
          Effect.mapError(() => new AgentSessionNotFound()),
        );

        const brief = Option.fromNullishOr(allOutputs.find((o) => o.type === "project_brief"));
        const prd = Option.fromNullishOr(allOutputs.find((o) => o.type === "implementation_prd"));

        return new GetAgentSessionFinalOutputResponse({
          projectBrief: Option.match(brief, { onNone: () => null, onSome: (r) => r.content ?? null }),
          implementationPrd: Option.match(prd, { onNone: () => null, onSome: (r) => r.content ?? null }),
          version: Option.match(brief, { onNone: () => null, onSome: (r) => r.version ?? null }),
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
