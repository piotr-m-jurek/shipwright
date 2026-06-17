import z from "zod/v4";

// Item attributed to a source document — used in summaries and gap reports.
// sourceDocument is required and never optional — this is the anti-hallucination contract.
export const ItemWithSourceSchema = z.object({
  text: z.string(),
  sourceDocument: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
});

// Output schema for both map and reduce summarizer passes.
// The map pass produces one of these per chunk batch.
// The reduce pass produces one of these as the final per-document summary.
export const DocumentSummarySchema = z.object({
  sourceDocument: z.string(), // filename — required, never optional
  summary: z.string(), // prose summary of the content
  requirements: z.array(ItemWithSourceSchema),
  constraints: z.array(ItemWithSourceSchema),
  assumptions: z.array(ItemWithSourceSchema),
});

export type DocumentSummary = z.infer<typeof DocumentSummarySchema>;

export const ConflictSchema = z.object({
  description: z.string(),
  documentA: z.string(), // filename of first source
  documentB: z.string(), // filename of second source
});

export const GapReportSchema = z.object({
  conflicts: z.array(ConflictSchema),
  gaps: z.array(
    z.object({
      description: z.string(),
      affectedArea: z.string(),
    }),
  ),
  ambiguities: z.array(
    z.object({
      description: z.string(),
      sourceDocument: z.string(),
    }),
  ),
});

export type GapReport = z.infer<typeof GapReportSchema>;

const ClarifyingQuestionSchema = z.object({
  text: z.string(),
  rationale: z.string(),
  sourceDocuments: z.array(z.string()),
  priority: z.enum(["high", "medium", "low"]),
});

export const ClarifyingQuestionsSchema = z.object({
  questions: z.array(ClarifyingQuestionSchema).min(3).max(7),
  stopReason: z.enum(["sufficient_gaps", "round_limit"]).optional(),
});

export type ClarifyingQuestions = z.infer<typeof ClarifyingQuestionsSchema>;
