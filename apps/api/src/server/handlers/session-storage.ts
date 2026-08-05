import { Effect, Option, pipe } from "effect";
import { StorageAdapter } from "../../storage/index.js";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  ConfirmUploadError,
  CreateAgentSessionError,
  MissingUploads,
  OutputNotFoundError,
} from "@shipwright/shared/domain/errors.js";
import {
  CreateAgentSessionResponse,
  ConfirmUploadResponse,
  OutputDownloadUrlResponse,
} from "@shipwright/shared/schemas/api.js";
import { Api } from "@shipwright/shared/api.js";
import { AgentSessionRepository } from "../../db/repositories/agent-session-repository.ts";
import { OutputRepository } from "../../db/repositories/output-repository.ts";
import { CurrentUser } from "@shipwright/shared/middleware.js";
import { createUploadSession } from "../../agent/pipelines/create-upload-session.js";
import { confirmUploadResults } from "../../agent/pipelines/confirm-upload-results.js";
import { MessageQueue } from "../../queue/index.ts";

export const SessionStorage = HttpApiBuilder.group(Api, "storage", (handlers) =>
  handlers
    .handle(
      "sessionUploadUrl",
      Effect.fn("handler/createUploadSession")(function* (p) {
        const user = yield* CurrentUser;

        const { uploads, sessionId } = yield* pipe(
          createUploadSession({ files: p.payload.files, userId: user.id }),
          Effect.mapError(() => new CreateAgentSessionError()),
        );
        return new CreateAgentSessionResponse({ uploads, sessionId });
      }),
    )
    .handle(
      "confirmUpload",
      Effect.fn("handler/confirmUploads")(function* ({ payload: { uploads }, params: { sessionId } }) {
        const mq = yield* MessageQueue;

        const results = yield* pipe(
          confirmUploadResults(uploads),
          Effect.mapError(() => new ConfirmUploadError()),
        );

        const missingKeys = results.filter((r) => !r.exists).map((r) => r.s3Key);
        if (missingKeys.length > 0) {
          return yield* new MissingUploads({ missingKeys });
        }

        yield* mq.publish("documents.process", { sessionId, uploads });
        return new ConfirmUploadResponse({ valid: true });
      }),
    )
    .handle("getOutputDownloadUrl", ({ params: { sessionId, type } }) =>
      Effect.gen(function* () {
        const agentSessionDb = yield* AgentSessionRepository;
        const outputDb = yield* OutputRepository;
        const user = yield* CurrentUser;

        yield* agentSessionDb.getAgentSessionByIdForUser({ sessionId, userId: user.id }).pipe(
          Effect.mapError(() => new OutputNotFoundError()),
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail(new OutputNotFoundError()),
            onSome: Effect.succeed,
          })),
        );

        // Validate type param
        if (type !== "project_brief" && type !== "implementation_prd") {
          return yield* new OutputNotFoundError();
        }

        const s3Key = yield* outputDb.getLatestOutputByType({ sessionId, type }).pipe(
          Effect.mapError(() => new OutputNotFoundError()),
          Effect.flatMap((opt) =>
            Option.match(
              pipe(opt, Option.flatMap((r) => Option.fromNullishOr(r.s3Key))),
              {
                onNone: () => Effect.fail(new OutputNotFoundError()),
                onSome: Effect.succeed,
              },
            )
          ),
        );

        const storage = yield* StorageAdapter;
        // Generate presigned GET URL with 15-minute TTL (not a PUT URL)
        const url = yield* pipe(
          storage.generatePresignedGetUrl(s3Key, 15),
          Effect.mapError(() => new OutputNotFoundError()),
        );

        return new OutputDownloadUrlResponse({ url });
      }),
    ),
);
