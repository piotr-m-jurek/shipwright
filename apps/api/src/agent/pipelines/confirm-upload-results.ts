import { Effect, pipe } from "effect";
import { StorageAdapter } from "@shipwright/storage";
import { ConfirmUploadRequest } from "@shipwright/shared/schemas/api";
import { Spans } from "@shipwright/observability";

export const confirmUploadResults = Effect.fn("agent/confirmUploadResults")(function* (
  uploads: ConfirmUploadRequest["uploads"],
) {
  yield* Effect.annotateCurrentSpan(Spans.uploadCount(uploads.length));
  const storage = yield* StorageAdapter;
  return yield* pipe(
    uploads,
    Effect.forEach(
      ({ s3Key }) => storage.headObject(s3Key).pipe(Effect.map((exists) => ({ s3Key, exists }))),
      { concurrency: 10 },
    ),
  );
});
