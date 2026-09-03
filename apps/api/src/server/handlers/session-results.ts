import { Effect, Option, pipe } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  AnalysisPipelineError,
  RevisionError,
  OutputNotFoundError,
} from "@shipwright/shared/domain/errors";
import {
  PostAgentSessionAnswersResponse,
  GetAgentSessionFinalOutputResponse,
  ReviseResponse,
  OutputDiffResponse,
} from "@shipwright/shared/schemas/api";
import { Api } from "@shipwright/shared/api";
import { OutputRepository } from "@shipwright/db/repositories/output-repository";
import { CurrentUser } from "@shipwright/shared/middleware";
import { submitAnswers } from "../../agent/pipelines/submit-answers";
import { startRevision } from "../../agent/pipelines/generation";
import { diffOutputSections } from "../../agent/output-diff";
import { requireOwnedSession } from "./require-owned-session";
import { toServiceUnavailable } from "./service-unavailable";

export const SessionResults = HttpApiBuilder.group(Api, "results", (handlers) =>
  handlers
    .handle("submitSessionAnswers", ({ payload: { answers }, params: { sessionId } }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;

        // Ownership check — 404 for unknown/other-user session, 503 if the
        // store itself failed.
        yield* requireOwnedSession(sessionId, user.id);

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
        const outputDb = yield* OutputRepository;
        const user = yield* CurrentUser;

        yield* requireOwnedSession(sessionId, user.id);

        // getOutputsBySessionId returns an array (possibly empty when no
        // output exists yet) — its only failure mode is a genuine store
        // error, never "not found", so it maps to ServiceUnavailableError,
        // not AgentSessionNotFound (which the ownership check above already
        // owns).
        const allOutputs = yield* outputDb.getOutputsBySessionId(sessionId).pipe(toServiceUnavailable);

        const brief = Option.fromNullishOr(allOutputs.find((o) => o.type === "project_brief"));
        const prd = Option.fromNullishOr(allOutputs.find((o) => o.type === "implementation_prd"));

        return new GetAgentSessionFinalOutputResponse({
          projectBrief: Option.match(brief, {
            onNone: () => null,
            onSome: (r) => r.content ?? null,
          }),
          implementationPrd: Option.match(prd, {
            onNone: () => null,
            onSome: (r) => r.content ?? null,
          }),
          version: Option.match(brief, { onNone: () => null, onSome: (r) => r.version ?? null }),
        });
      }),
    )
    .handle("reviseOutput", ({ payload: { feedback }, params: { sessionId } }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;

        // Ownership check — 404 for unknown/other-user session, 503 if the
        // store itself failed.
        yield* requireOwnedSession(sessionId, user.id);

        const result = yield* pipe(
          startRevision(sessionId, feedback),
          Effect.mapError((e) => (e._tag === "SessionStateError" ? e : new RevisionError())),
        );
        return new ReviseResponse({ started: result.started });
      }),
    )
    // type/from/to are already validated (literal union / branded
    // NumberFromString) by the endpoint's own param schema — see api.ts.
    .handle("getOutputDiff", ({ params: { sessionId, type, from, to } }) =>
      Effect.gen(function* () {
        const outputDb = yield* OutputRepository;
        const user = yield* CurrentUser;

        yield* requireOwnedSession(sessionId, user.id);

        const allOutputs = yield* outputDb.getOutputsBySessionId(sessionId).pipe(toServiceUnavailable);
        const oldOutput = allOutputs.find((o) => o.type === type && o.version === from);
        const newOutput = allOutputs.find((o) => o.type === type && o.version === to);
        if (!oldOutput || !newOutput) {
          return yield* new OutputNotFoundError();
        }

        const sections = diffOutputSections(oldOutput.content ?? "", newOutput.content ?? "");
        return new OutputDiffResponse({ sections });
      }),
    ),
);
