import { Schema } from "effect";
import { AgentSessionId, DocumentId, QuestionId, SummaryId } from "../domain/ids.ts";

export class MachineContextEffectSchema extends Schema.Class<MachineContextEffectSchema>(
  "MachineContextEffectSchema",
)({
  sessionId: AgentSessionId,
  documents: Schema.Array(
    Schema.Struct({
      id: DocumentId,
      filename: Schema.String,
      tokenCount: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  ),
  // Latest final summary per document, loaded before the analyzing state.
  // All downstream passes (Challenger, Writers) consume these — never raw text.
  documentSummaries: Schema.Array(
    Schema.Struct({
      id: SummaryId, // document_summaries.id
      documentId: DocumentId,
      sourceDocument: Schema.String, // documents.filename
      content: Schema.String, // final summary content
      tokenCount: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  ),
  questions: Schema.Array(
    Schema.Struct({
      id: QuestionId,
      text: Schema.String,
      rationale: Schema.String,
      sourceDocuments: Schema.Array(Schema.String),
    }),
  ),
  answers: Schema.Array(
    Schema.Struct({
      questionId: QuestionId,
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
}) {}

export type MachineContext = typeof MachineContextEffectSchema.Type;
