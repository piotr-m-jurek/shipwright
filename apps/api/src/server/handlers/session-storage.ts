import { Effect, Option, pipe } from "effect";
import { StorageAdapter } from "@shipwright/storage";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  AgentSessionNotFound,
  ConfirmUploadError,
  CreateAgentSessionError,
  MissingUploads,
  OutputNotFoundError,
  RetrySessionError as RetrySessionHttpError,
} from "@shipwright/shared/domain/errors";
import {
  CreateAgentSessionResponse,
  ConfirmUploadResponse,
  OutputDownloadUrlResponse,
  RetrySessionResponse,
} from "@shipwright/shared/schemas/api";
import { Api } from "@shipwright/shared/api";
import { OutputRepository } from "@shipwright/db/repositories/output-repository";
import { CurrentUser } from "@shipwright/shared/middleware";
import { createUploadSession } from "../../agent/pipelines/create-upload-session";
import { confirmUploadResults } from "../../agent/pipelines/confirm-upload-results";
import { retrySession } from "../../agent/pipelines/retry-session";
import { DocumentsProcess } from "@shipwright/queue";
import { requireOwnedSession } from "./require-owned-session";
import { toServiceUnavailable } from "./service-unavailable";

export const SessionStorage = HttpApiBuilder.group(Api, "storage", (handlers) =>
  handlers
    .handle(
      "sessionUploadUrl",
      Effect.fn("handler/createUploadSession")(function* (p) {
        const user = yield* CurrentUser;

        const { uploads, sessionId } = yield* pipe(
          createUploadSession({ files: p.payload.files, userId: user.id }),
          Effect.mapError((cause) => new CreateAgentSessionError({ cause })),
        );
        return new CreateAgentSessionResponse({ uploads, sessionId });
      }),
    )
    .handle(
      "confirmUpload",
      Effect.fn("handler/confirmUploads")(function* ({ payload: { uploads }, params: { sessionId } }) {
        const results = yield* pipe(
          confirmUploadResults(uploads),
          Effect.mapError(() => new ConfirmUploadError()),
        );

        const missingKeys = results.filter((r) => !r.exists).map((r) => r.s3Key);
        if (missingKeys.length > 0) {
          return yield* new MissingUploads({ missingKeys });
        }

        yield* DocumentsProcess.enqueue({ sessionId, uploads });
        return new ConfirmUploadResponse({ valid: true });
      }),
    )
    .handle("retrySession", ({ params: { sessionId } }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser;
        yield* retrySession(sessionId, user.id).pipe(
          Effect.catchReason(
            "shipwright/agent/RetrySessionError",
            "SessionNotFoundReason",
            () => new AgentSessionNotFound(),
          ),
          Effect.mapError((e) => new RetrySessionHttpError({ cause: e })),
        );
        return new RetrySessionResponse({ queued: true });
      }),
    )
    .handle("getOutputDownloadUrl", ({ params: { sessionId, type } }) =>
      Effect.gen(function* () {
        const outputDb = yield* OutputRepository;
        const user = yield* CurrentUser;

        // This endpoint's contract deliberately uses one 404 flavor
        // (OutputNotFoundError) for both "no such session" and "no such
        // output" — the client doesn't need to distinguish. A genuine store
        // failure is a different thing, though: map that to
        // ServiceUnavailableError instead of misreporting it as a 404.
        yield* requireOwnedSession(sessionId, user.id).pipe(
          Effect.catchTag("AgentSessionNotFound", () => new OutputNotFoundError()),
        );

        // Validate type param
        if (type !== "project_brief" && type !== "implementation_prd") {
          return yield* new OutputNotFoundError();
        }

        const s3Key = yield* outputDb.getLatestOutputByType({ sessionId, type }).pipe(
          toServiceUnavailable,
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
        // Generate presigned GET URL with 15-minute TTL (not a PUT URL) — a
        // failure here is a storage/infra issue, not "output not found" (the
        // output row above was found fine); ServiceUnavailableError, not
        // OutputNotFoundError.
        const url = yield* pipe(storage.generatePresignedGetUrl(s3Key, 15), toServiceUnavailable);

        return new OutputDownloadUrlResponse({ url });
      }),
    ),
);
