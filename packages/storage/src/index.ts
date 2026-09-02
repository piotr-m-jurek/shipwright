import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { ConfigService } from "@shipwright/config";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Context, Layer, Schema, Effect, Redacted } from "effect";

export class UploadError extends Schema.TaggedError<UploadError>()(
  "shipwright/storage/UploadError",
  { cause: Schema.Defect() },
) {}

export class DownloadError extends Schema.TaggedError<DownloadError>()(
  "shipwright/storage/DownloadError",
  { cause: Schema.Defect(), message: Schema.optional(Schema.String) },
) {}

export class DeleteError extends Schema.TaggedError<DeleteError>()(
  "shipwright/storage/DeleteError",
  { cause: Schema.Defect() },
) {}

export class PresignedUrlError extends Schema.TaggedError<PresignedUrlError>()(
  "shipwright/storage/PresignedUrlError",
  { cause: Schema.Defect() },
) {}

export class HeadObjectError extends Schema.TaggedError<HeadObjectError>()(
  "shipwright/storage/HeadObjectError",
  { cause: Schema.Defect() },
) {}

export class StorageAdapter extends Context.Service<
  StorageAdapter,
  {
    upload(key: string, body: Buffer): Effect.Effect<void, UploadError>;
    download(key: string): Effect.Effect<Buffer, DownloadError>;
    downloadPartialObject(key: string, length: number): Effect.Effect<Uint8Array, DownloadError>;
    remove(key: string): Effect.Effect<void, DeleteError>;
    /** Generate a presigned PUT URL (for client uploads). */
    generatePresignedUrl(
      key: string,
      mimeType: string,
      ttlInMins: number,
    ): Effect.Effect<string, PresignedUrlError>;
    /** Generate a presigned GET URL (for client downloads). */
    generatePresignedGetUrl(
      key: string,
      ttlInMins: number,
    ): Effect.Effect<string, PresignedUrlError>;
    headObject(key: string): Effect.Effect<boolean, HeadObjectError>;
  }
>()("shipwright/storage/StorageAdapter") {
  static readonly layer = Layer.effect(
    StorageAdapter,
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const client = new S3Client({
        endpoint: config.storage.endpoint,
        credentials: {
          accessKeyId: Redacted.value(config.storage.accessKey),
          secretAccessKey: Redacted.value(config.storage.secretKey),
        },
        forcePathStyle: true,
        // Only add checksum headers when the operation explicitly requires them.
        // Without this, SDK v3 appends x-amz-sdk-checksum-algorithm=CRC32 to
        // every presigned PUT URL, which RustFS doesn't understand.
        requestChecksumCalculation: "WHEN_REQUIRED",
      });

      yield* Effect.log("[storage] bucket ready", {
        bucket: config.storage.bucket,
      });

      const upload = Effect.fn("storage/upload")(function* (key: string, body: Buffer) {
        const command = new PutObjectCommand({
          Bucket: config.storage.bucket,
          Key: key,
          Body: body,
        });

        yield* Effect.tryPromise({
          try: () => client.send(command),
          catch(error) {
            return new UploadError({ cause: error });
          },
        });
      });

      const download = Effect.fn("storage/download")(
        function* (key: string) {
          const command = new GetObjectCommand({
            Bucket: config.storage.bucket,
            Key: key,
          });

          return yield* Effect.tryPromise({
            try: () => client.send(command),
            catch: (error) =>
              new DownloadError({
                cause: error,
                message: "Error sending download command to s3",
              }),
          });
        },
        Effect.andThen((rawData) => Effect.fromNullishOr(rawData.Body)),
        Effect.andThen((body) =>
          Effect.tryPromise({
            try: () => body.transformToByteArray(),
            catch: (cause) =>
              new DownloadError({ cause, message: "Error transforming to byte array" }),
          }),
        ),
        Effect.map((a) => Buffer.from(a)),
        Effect.catchTag("NoSuchElementError", (cause) =>
          Effect.fail(new DownloadError({ cause, message: "No body found on the data from s3" })),
        ),
      );

      const downloadPartialObject = Effect.fn("storage/downloadPartialObject")(
        function* (key: string, length: number) {
          const command = new GetObjectCommand({
            Bucket: config.storage.bucket,
            Key: key,
            Range: `bytes=0-${length}`,
          });
          return yield* Effect.tryPromise({
            try: () => client.send(command),
            catch: (cause) => new DownloadError({ cause }),
          });
        },
        Effect.andThen((rawData) => Effect.fromNullishOr(rawData.Body)),
        Effect.andThen((body) =>
          Effect.tryPromise({
            try: () => body.transformToByteArray(),
            catch: (cause) =>
              new DownloadError({ cause, message: "Error transforming to byte array" }),
          }),
        ),
        Effect.catchTag("NoSuchElementError", (cause) =>
          Effect.fail(new DownloadError({ cause, message: "No body found on the data from s3" })),
        ),
      );

      const remove = Effect.fn("storage/delete")(function* (key: string) {
        const command = new DeleteObjectCommand({
          Bucket: config.storage.bucket,
          Key: key,
        });
        return yield* Effect.tryPromise({
          try: () => client.send(command),
          catch: (cause) => new DeleteError({ cause }),
        });
      });

      const generatePresignedUrl = Effect.fn("storage/generatePresignedUrl")(function* (
        key: string,
        mimeType: string,
        ttlInMins: number,
      ) {
        const command = new PutObjectCommand({
          Bucket: config.storage.bucket,
          Key: key,
          ContentType: mimeType,
        });

        const result = yield* Effect.tryPromise({
          try: () => getSignedUrl(client, command, { expiresIn: ttlInMins * 60 }),
          catch: (cause) => new PresignedUrlError({ cause }),
        });
        return result;
      });

      const generatePresignedGetUrl = Effect.fn("storage/generatePresignedGetUrl")(function* (
        key: string,
        ttlInMins: number,
      ) {
        const command = new GetObjectCommand({
          Bucket: config.storage.bucket,
          Key: key,
        });
        const result = yield* Effect.tryPromise({
          try: () => getSignedUrl(client, command, { expiresIn: ttlInMins * 60 }),
          catch: (cause) => new PresignedUrlError({ cause }),
        });
        return result;
      });

      const headObject = Effect.fn("storage/headObject")(
        function* (key: string) {
          const command = new HeadObjectCommand({
            Bucket: config.storage.bucket,
            Key: key,
          });
          return yield* Effect.tryPromise({
            try: () => client.send(command),
            catch: (cause) => new HeadObjectError({ cause }),
          });
        },
        Effect.map(() => true),
        Effect.catch((error) => {
          const cause = error.cause;
          if (
            cause instanceof Error &&
            (cause.name === "NotFound" ||
              cause.name === "NoSuchKey" ||
              ("$metadata" in cause &&
                [403, 404].includes((cause as any).$metadata?.httpStatusCode)))
          ) {
            return Effect.succeed(false);
          }
          return Effect.fail(error);
        }),
      );

      return StorageAdapter.of({
        upload,
        download,
        downloadPartialObject,
        remove: remove,
        generatePresignedUrl,
        generatePresignedGetUrl,
        headObject,
      });
    }),
  ).pipe(Layer.provide(ConfigService.layer));
}

export type StorageAdapterService = StorageAdapter["Service"];
