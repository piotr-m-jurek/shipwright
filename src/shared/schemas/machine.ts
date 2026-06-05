import z from "zod/v4";
import { SelectAgentSessionSchema, SelectDocumentSchema } from "./index.js";

export const MachineContextSchema = z.object({
  sessionId: SelectAgentSessionSchema.shape.id,
  documents: z.array(
    SelectDocumentSchema.pick({
      id: true,
      filename: true,
      documentType: true,
      tokenCount: true,
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
  outputs: z.object({
    projectBrief: z.string().optional(),
    implementationPrd: z.string().optional(),
  }),
});
