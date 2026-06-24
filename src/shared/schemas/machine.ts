import z from "zod/v4";
import { documentTypeEnum } from "../../db/schema.js";
import { Schema } from "effect";

// Extract the enum values from the Drizzle enum directly — stays in sync with schema.ts.
const documentTypeLiteral = documentTypeEnum.enumValues;

const DocumentTypeSchema = z.enum(documentTypeLiteral);
const DocumentTypeEffectSchema = Schema.Literals(documentTypeLiteral);

export class MachineContextSchema1 extends Schema.TaggedClass<MachineContextSchema1>()(
  "MachineContextSchema1",
  {
    sessionId: Schema.String.check(Schema.isUUID()),
    documents: Schema.Array(Schema.Struct({})),
  },
) {}

export const MachineContextSchema = z.object({
  sessionId: z.uuid(),
  documents: z.array(
    z.object({
      id: z.uuid(),
      filename: z.string(),
      documentType: DocumentTypeSchema,
      tokenCount: z.number().int().positive(),
    }),
  ),
  // Latest final summary per document, loaded before the analyzing state.
  // All downstream passes (Challenger, Writers) consume these — never raw text.
  documentSummaries: z.array(
    z.object({
      id: z.uuid(), // document_summaries.id
      documentId: z.uuid(),
      sourceDocument: z.string(), // documents.filename
      documentType: DocumentTypeSchema,
      content: z.string(), // final summary content
      tokenCount: z.number().int().positive(),
    }),
  ),
  questions: z.array(
    z.object({
      id: z.uuid(),
      text: z.string(),
      rationale: z.string(),
      sourceDocuments: z.array(z.string()),
    }),
  ),
  answers: z.array(
    z.object({
      questionId: z.uuid(),
      text: z.string(),
      round: z.number().int(),
    }),
  ),
  round: z.number().int().min(0).max(2),
  inputMode: z.enum(["context", "retrieval"]),
  agentAnalysis: z.unknown().nullable(),
  // Set when REVISION_REQUESTED is fired; cleared after generating completes.
  revisionFeedback: z.string().nullable(),
  // Starts at 1, increments on each pass through generating.
  outputVersion: z.number().int().min(1),
  outputs: z.object({
    projectBrief: z.string().optional(),
    implementationPrd: z.string().optional(),
  }),
});

export type MachineContext = z.infer<typeof MachineContextSchema>;

export const MachineContextEffectSchema = Schema.Struct({
  sessionId: Schema.String.check(Schema.isUUID()),
  documents: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isUUID()),
      filename: Schema.String,
      documentType: DocumentTypeEffectSchema,
      tokenCount: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  ),
  // Latest final summary per document, loaded before the analyzing state.
  // All downstream passes (Challenger, Writers) consume these — never raw text.
  documentSummaries: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isUUID()), // document_summaries.id
      documentId: Schema.String.check(Schema.isUUID()),
      sourceDocument: Schema.String, // documents.filename
      documentType: DocumentTypeEffectSchema,
      content: Schema.String, // final summary content
      tokenCount: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  ),
  questions: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isUUID()),
      text: Schema.String,
      rationale: Schema.String,
      sourceDocuments: Schema.Array(Schema.String),
    }),
  ),
  answers: Schema.Array(
    Schema.Struct({
      questionId: Schema.String.check(Schema.isUUID()),
      text: Schema.String,
      round: Schema.Int,
    }),
  ),
  round: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
  inputMode: Schema.Literals(["context", "retrieval"]),
  agentAnalysis: Schema.NullOr(Schema.Unknown),
  // Set when REVISION_REQUESTED is fired; cleared after generating completes.
  revisionFeedback: Schema.NullOr(Schema.String),
  // Starts at 1, increments on each pass through generating.
  outputVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  outputs: Schema.Struct({
    projectBrief: Schema.optional(Schema.String),
    implementationPrd: Schema.optional(Schema.String),
  }),
});
