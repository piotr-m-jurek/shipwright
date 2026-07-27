import type { AgentSessionId } from "@shipwright/shared/domain/ids";
import { Effect } from "effect";
import { DatabaseService } from "../../db/queries.js";
import { getOrRestoreActor } from "../session-actor.js";
import { summarizeAllDocuments } from "../writers/summarizer.js";
import { runChallenger } from "../writers/challenger.js";
import { runQuestionGenerator } from "../writers/question-generator.js";
import { AnalysisPipelineError } from "../errors.js";

export const runSessionWorkflow = Effect.fn("agent/runSessionWorkflow")(
  function* (sessionId: AgentSessionId) {
    const db = yield* DatabaseService;
    const actor = yield* getOrRestoreActor(sessionId);

    yield* summarizeAllDocuments(sessionId);

    const documentSummaries = yield* db.getFinalSummariesBySession(sessionId);
    actor.send({
      type: "SUMMARIZATION_DONE",
      documentSummaries: documentSummaries.map((summary) => ({
        id: summary.id,
        content: summary.summary,
        documentId: summary.documentId,
        sourceDocument: summary.sourceDocument,
        tokenCount: summary.tokenCount,
      })),
    });
    actor.send({
      type: "USER_CONFIRM",
    });

    const gapReport = yield* runChallenger(documentSummaries);
    const { questions: generatedQuestions } = yield* runQuestionGenerator(
      gapReport,
      documentSummaries,
    );
    const dbQuestions = yield* db.createQuestions(
      generatedQuestions.map((q, idx) => ({
        text: q.text,
        rationale: q.rationale,
        sourceDocuments: [...q.sourceDocuments], // TODO: Readonly string is not assignalbe to blah blah...
        sessionId: sessionId,
        orderIndex: idx + 1,
      })),
    );

    actor.send({
      type: "ANALYSIS_DONE",
      gapReport,
      questions: dbQuestions.map((q) => ({
        id: q.id,
        rationale: q.rationale,
        sourceDocuments: q.sourceDocuments,
        text: q.text,
      })),
    });
  },
  Effect.mapError((cause) => new AnalysisPipelineError({ cause })),
);
