import z from "zod/v4";
import { documentTypeLiteral } from "../../db/out/schema.js";

export const MachineContextSchema = z.object({
  sessionId: z.uuid(),
  documents: z.array(
    z.object({
      id: z.uuid(),
      filename: z.string(),
      documentType: z.literal(documentTypeLiteral),
      tokenCount: z.number,
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
export type MachineContext = z.infer<typeof MachineContextSchema>;
