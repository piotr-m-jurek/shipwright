import z from "zod/v4";
import { documentTypeLiteral } from "../../db/out/schema.js";

const DocumentTypeSchema = z.enum(documentTypeLiteral);

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
