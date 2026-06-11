import z from "zod/v4";
import { InsertDocumentSchema } from "./index.js";
import { Schema } from "effect";

export namespace EffectSession {
  export class CreateSessionRequestSchema extends Schema.Class<CreateSessionRequestSchema>(
    "CreateSessionRequestSchema",
  )({
    files: Schema.Array(
      Schema.Struct({
        filename: Schema.String,
        documentType: Schema.Literals(["transcript", "prd_draft", "rfp", "notes"]),
        mimeType: Schema.String,
        sizeBytes: Schema.Number.check(Schema.isLessThan(100_000_000)),
      }),
    ).check(Schema.isMinLength(1)),
  }) {}

  export class CreateSessionResponse extends Schema.Class<CreateSessionResponse>(
    "CreateSessionResponse",
  )({
    sessionId: Schema.String,
    uploads: Schema.Array(
      Schema.Struct({
        presignedUrl: Schema.String,
        s3Key: Schema.String,
        documentId: Schema.String,
      }),
    ),
  }) {}

  export class ConfirmUploadRequestSchema extends Schema.Class<ConfirmUploadRequestSchema>(
    "ConfirmUploadRequestSchema",
  )({
    uploads: Schema.Array(
      Schema.Struct({
        s3Key: Schema.String,
        documentId: Schema.String,
      }),
    ),
  }) {}
}

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export const CreateSessionRequestSchema = z.object({
  files: z
    .array(
      z.object({
        filename: z.string(),
        documentType: InsertDocumentSchema.shape.documentType,
        mimeType: z.string(),
        sizeBytes: z.number().max(100_000_000),
      }),
    )
    .min(1),
});

export type CreateSessionResponse = {
  sessionId: string;
  uploads: {
    presignedUrl: string;
    s3Key: string;
    documentId: string;
  }[];
};

export type ConfirmUploadRequest = z.infer<typeof ConfirmUploadRequestSchema>;
export const ConfirmUploadRequestSchema = z.object({
  uploads: z.array(
    z.object({
      s3Key: z.string(),
      documentId: z.string(),
    }),
  ),
});
