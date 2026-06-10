import { Schema } from "effect";
import z from "zod/v4";

export namespace EffectSchemas {
  export class RequirementSchema extends Schema.Class<RequirementSchema>("RequirementSchema")({
    text: Schema.String,
    sourceDocument: Schema.String,
    confidence: Schema.Literals(["high", "medium", "low"]),
  }) {}

  export class DocumentAnalysisSchema extends Schema.Class<DocumentAnalysisSchema>(
    "DocumentAnalysisSchema",
  )({
    requirements: Schema.Array(RequirementSchema),
    constraints: Schema.Array(RequirementSchema),
    assumptions: Schema.Array(RequirementSchema),
  }) {}

  export class ConflictSchema extends Schema.Class<ConflictSchema>("ConflictSchema")({
    description: Schema.String,
    documentA: Schema.String,
    documentB: Schema.String,
  }) {}

  class GapsSchema extends Schema.Class<GapsSchema>("GapsSchema")({
    description: Schema.String,
    affectedArea: Schema.String,
  }) {}

  class AmbiguitiesSchema extends Schema.Class<AmbiguitiesSchema>("AmbiguitiesSchema")({
    description: Schema.String,
    sourceDocument: Schema.String,
  }) {}

  export class GapReportSchema extends Schema.Class<GapReportSchema>("GapReportSchema")({
    conflicts: Schema.Array(ConflictSchema),
    gaps: Schema.Array(GapsSchema),
    ambiguities: Schema.Array(AmbiguitiesSchema),
  }) {}
}

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
