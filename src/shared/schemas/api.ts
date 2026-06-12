import z from "zod/v4";
import { InsertDocumentSchema } from "./index.js";

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


export const SubmitAnswersSchema = z.object({
  answers: z
    .object({
      questionId: z.uuid(),
      text: z.string().min(1),
    })
    .array()
    .min(1),
});

