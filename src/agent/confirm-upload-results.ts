import { Effect, pipe } from "effect";
import { ConfirmUploadRequest } from "../shared/schemas/sessions.js";
import { EffectStorageAdapterService } from "../storage/index.js";

export const confirmUploadResults = Effect.fn("agent/confirmUploadResults")(function* (
  uploads: ConfirmUploadRequest["uploads"],
) {
  const storage = yield* EffectStorageAdapterService.EffectStorageAdapter;
  return yield* pipe(
    uploads,
    Effect.forEach(
      ({ s3Key }) =>
        pipe(
          storage.headObject(s3Key),
          Effect.map((exists) => ({ s3Key, exists })),
        ),
      { concurrency: 10 },
    ),
  );
});
