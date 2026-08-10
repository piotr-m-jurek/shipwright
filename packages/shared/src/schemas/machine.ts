import { Schema } from "effect";
import { AgentSessionId, QuestionId, SummaryId } from "../domain/ids";
import { TokenCount } from "../domain/value-objects";

// Per-document extraction status tracked in the machine.
// Uses filename (domain concept) not DocumentId (DB concern).
export class DocumentExtractionStatus extends Schema.Opaque<DocumentExtractionStatus>()(
  Schema.Struct({
    filename: Schema.String,
    status: Schema.Literals(["pending", "done", "failed"]),
  }),
) {}

export class MachineContextEffectSchema extends Schema.Class<MachineContextEffectSchema>(
  "MachineContextEffectSchema",
)({
  sessionId: AgentSessionId,
  // Domain-level document tracking: filename + extraction status only.
  // No DB IDs — those are a persistence concern, not machine state.
  documents: Schema.Array(DocumentExtractionStatus),
  // Latest final summary per document, loaded before the analyzing state.
  // All downstream passes (Challenger, Writers) consume these — never raw text.
  // SummaryId retained for downstream reference (e.g. fetching items); no other DB IDs.
  documentSummaries: Schema.Array(
    Schema.Struct({
      id: SummaryId,
      sourceDocument: Schema.String, // documents.filename — domain identity
      content: Schema.String,
      tokenCount: TokenCount,
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
  agentAnalysis: Schema.Option(Schema.Unknown),
  // Set when REVISION_REQUESTED is fired; cleared after generating completes.
  revisionFeedback: Schema.Option(Schema.String),
  // Starts at 1, increments on each pass through generating.
  outputVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  outputs: Schema.Struct({
    projectBrief: Schema.optional(Schema.String),
    implementationPrd: Schema.optional(Schema.String),
  }),
}) {}

export type MachineContext = typeof MachineContextEffectSchema.Type;
