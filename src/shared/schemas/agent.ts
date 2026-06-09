import z from "zod/v4";

export const RequirementSchema = z.object({
  text: z.string(),
  sourceDocument: z.string(), // required — never optional
  confidence: z.enum(["high", "medium", "low"]),
});

export const DocumentAnalysisSchema = z.object({
  requirements: z.array(RequirementSchema),
  constraints: z.array(RequirementSchema),
  assumptions: z.array(RequirementSchema),
});

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

export type DocumentAnalysis = z.infer<typeof DocumentAnalysisSchema>;
export type GapReport = z.infer<typeof GapReportSchema>;
