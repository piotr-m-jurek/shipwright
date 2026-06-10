import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Context, Layer, Schema, Effect } from "effect";

export namespace EffectStorageAdapterService {
  export class UploadError extends Schema.TaggedErrorClass<UploadError>()(
    "shipwreck/storage/UploadError",
    { cause: Schema.Defect() },
  ) {}

  export class DownloadError extends Schema.TaggedErrorClass<DownloadError>()(
    "shipwreck/storage/DownloadError",
    { cause: Schema.Defect(), message: Schema.optional(Schema.String) },
  ) {}

  export class DeleteError extends Schema.TaggedErrorClass<DeleteError>()(
    "shipwreck/storage/DeleteError",
    { cause: Schema.Defect() },
  ) {}

  export class PresignedUrlError extends Schema.TaggedErrorClass<PresignedUrlError>()(
    "shipwreck/storage/PresignedUrlError",
    { cause: Schema.Defect() },
  ) {}

  export class HeadObjectError extends Schema.TaggedErrorClass<HeadObjectError>()(
    "shipwreck/storage/HeadObjectError",
    { cause: Schema.Defect() },
  ) {}

  export class EffectStorageAdapter extends Context.Service<
    EffectStorageAdapter,
    {
      upload(key: string, body: Buffer): Effect.Effect<void, UploadError>;
      download(key: string): Effect.Effect<Buffer, DownloadError>;
      downloadPartialObject(key: string, length: number): Effect.Effect<Uint8Array, DownloadError>;
      remove(key: string): Effect.Effect<void, DeleteError>;
      generatePresignedUrl(
        key: string,
        mimeType: string,
        ttlInMins: number,
      ): Effect.Effect<string, PresignedUrlError>;
      headObject(key: string): Effect.Effect<boolean, HeadObjectError>;
    }
  >()("shipwreck/storage/EffectStorageAdapter") {
    static readonly layer = Layer.effect(
      EffectStorageAdapter,
      Effect.gen(function* () {
        yield* Effect.void;
        // TODO ^ temporary for the sake of

        const client = new S3Client({
          endpoint: config.storage.endpoint,
          credentials: {
            accessKeyId: config.storage.accessKey,
            secretAccessKey: config.storage.secretKey,
          },
          forcePathStyle: true,
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

        const headObject = Effect.fn("storage/headObject")(
          function* (key: string) {
            const command = new HeadObjectCommand({
              Bucket: config.storage.bucket,
              Key: key,
            });
            return yield* Effect.tryPromise({
              try: () => client.send(command),
              catch: (e) => e,
            });
          },
          Effect.map(() => true),
          Effect.catch((error) => {
            if (
              error instanceof Error &&
              (error.name === "NotFound" ||
                error.name === "NoSuchKey" ||
                ("$metadata" in error &&
                  [403, 404].includes((error as any).$metadata?.httpStatusCode)))
            ) {
              return Effect.succeed(false);
            }
            return Effect.fail(new HeadObjectError({ cause: error }));
          }),
        );

        return EffectStorageAdapter.of({
          upload,
          download,
          downloadPartialObject,
          remove: remove,
          generatePresignedUrl,
          headObject,
        });
      }),
    );
  }

  export type EffectStorageAdapterService = EffectStorageAdapter["Service"];
}

export interface StorageAdapter {
  upload(key: string, body: Buffer): Promise<void>;
  download(key: string): Promise<Buffer>;
  downloadPartialObject(key: string, length: number): Promise<Uint8Array>;
  remove(key: string): Promise<void>;
  generatePresignedUrl(key: string, mimeType: string, ttlInMins: number): Promise<string>;
  headObject(key: string): Promise<boolean>;
}

export class S3Storage implements StorageAdapter {
  private instance: S3Client;
  constructor() {
    this.instance = new S3Client({
      endpoint: config.storage.endpoint,
      credentials: {
        accessKeyId: config.storage.accessKey,
        secretAccessKey: config.storage.secretKey,
      },
      forcePathStyle: true,
    });
  }

  async upload(key: string, body: Buffer): Promise<void> {
    const command = new PutObjectCommand({ Bucket: config.storage.bucket, Key: key, Body: body });

    await this.instance.send(command);
  }

  async download(key: string): Promise<Buffer> {
    const command = new GetObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
    });
    const rawData = await this.instance.send(command);
    if (!rawData.Body) {
      throw new FileNotFoundInBucketError();
    }

    return Buffer.from(await rawData.Body.transformToByteArray());
  }

  async downloadPartialObject(key: string, length: number): Promise<Uint8Array> {
    const command = new GetObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
      Range: `bytes=0-${length}`,
    });
    const rawData = await this.instance.send(command);
    if (!rawData.Body) {
      throw new FileNotFoundInBucketError();
    }

    return rawData.Body?.transformToByteArray();
  }

  async remove(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
    });
    await this.instance.send(command);
  }

  async generatePresignedUrl(key: string, mimeType: string, ttlInMins: number) {
    const command = new PutObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
      ContentType: mimeType,
    });

    const url = await getSignedUrl(this.instance, command, { expiresIn: ttlInMins * 60 });
    return url;
  }

  async headObject(key: string) {
    const command = new HeadObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
    });
    try {
      await this.instance.send(command);
      return true;
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        (error.name === "NotFound" ||
          error.name === "NoSuchKey" ||
          error.name === "UnknownError" ||
          // rustfs returns 403 for non-existent objects
          ("$metadata" in error &&
            (error as { $metadata: { httpStatusCode: number } }).$metadata?.httpStatusCode ===
              403) ||
          ("$metadata" in error &&
            (error as { $metadata: { httpStatusCode: number } }).$metadata?.httpStatusCode === 404))
      ) {
        return false;
      }
      throw error; // re-throw unexpected errors
    }
  }
}
