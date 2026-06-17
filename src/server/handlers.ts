import { Effect, pipe } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  AgentSessionNotFound,
  ConfirmUploadError,
  CreateAgentSessionError,
  MissingUploads,
} from "../shared/domain/errors.js";
import { getAgentSesionById } from "../db/queries.js";
import { confirmUploadResults } from "../agent/confirm-upload-results.js";
import { processUploadedDocuments } from "../agent/process-uploaded-documents.js";
import { createUploadSession } from "../agent/create-upload-session.js";
import {
  CreateAgentSessionResponse,
  GetAgentSessionResponse,
  ConfirmUploadResponse,
} from "../shared/schemas/api.js";
import { Api } from "./api/api.js";

export const SystemApiHandlers = HttpApiBuilder.group(Api, "system", (handlers) =>
  handlers
    .handle(
      "sessionUploadUrl",
      Effect.fnUntraced(function* ({ payload: { files } }) {
        const result = yield* pipe(
          createUploadSession(files),
          Effect.mapError(() => new CreateAgentSessionError()),
        );
        return CreateAgentSessionResponse.make({
          uploads: result.uploads,
          sessionId: result.sessionId,
        });
      }),
    )
    .handle("confirmUpload", ({ payload: { uploads }, params: { sessionId } }) =>
      Effect.gen(function* () {
        const results = yield* pipe(
          confirmUploadResults(uploads),
          Effect.mapError(() => new ConfirmUploadError()),
        );

        const missingKeys = results.filter((r) => !r.exists).map((r) => r.s3Key);
        if (missingKeys.length > 0) {
          return yield* new MissingUploads({ missingKeys });
        }
        yield* pipe(
          processUploadedDocuments({ sessionId, uploads }),
          Effect.mapError((cause) => Effect.logError("processUploadedDocuments failed", cause)),
          Effect.forkDetach,
        );

        return ConfirmUploadResponse.make({ valid: true });
      }),
    )
    .handle("getSessionProgress", () => Effect.die("NotImplemented"))
    .handle("submitSessionAnswers", () => Effect.die("NotImplemented"))
    .handle("getSessionFinalOutput", () => Effect.die("NotImplemented"))
    .handle("getAgentSessionById", ({ params }) =>
      pipe(
        Effect.tryPromise({
          try: () => getAgentSesionById(params.id),
          catch: () => new AgentSessionNotFound(),
        }),
        Effect.flatMap((session) =>
          session === undefined
            ? Effect.fail(new AgentSessionNotFound())
            : Effect.succeed(
                GetAgentSessionResponse.make({
                  id: session.id,
                  createdAt: session.createdAt,
                  status: session.status,
                }),
              ),
        ),
      ),
    )
    .handle("health", () => Effect.succeed("Healthy")),
);
