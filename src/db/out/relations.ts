import { defineRelations } from "drizzle-orm";
import * as schema from "./schema";

export const relations = defineRelations(schema, (r) => ({
	questions: {
		sessions: r.many.sessions({
			from: r.questions.id.through(r.answers.questionId),
			to: r.sessions.id.through(r.answers.sessionId),
			alias: "questions_id_sessions_id_via_answers"
		}),
		session: r.one.sessions({
			from: r.questions.sessionId,
			to: r.sessions.id,
			alias: "questions_sessionId_sessions_id"
		}),
	},
	sessions: {
		questionsViaAnswers: r.many.questions({
			alias: "questions_id_sessions_id_via_answers"
		}),
		documentsViaChunks: r.many.documents({
			alias: "documents_id_sessions_id_via_chunks"
		}),
		documentsSessionId: r.many.documents({
			alias: "documents_sessionId_sessions_id"
		}),
		messages: r.many.messages(),
		outputs: r.many.outputs(),
		questionsSessionId: r.many.questions({
			alias: "questions_sessionId_sessions_id"
		}),
	},
	documents: {
		sessions: r.many.sessions({
			from: r.documents.id.through(r.chunks.documentId),
			to: r.sessions.id.through(r.chunks.sessionId),
			alias: "documents_id_sessions_id_via_chunks"
		}),
		session: r.one.sessions({
			from: r.documents.sessionId,
			to: r.sessions.id,
			alias: "documents_sessionId_sessions_id"
		}),
	},
	messages: {
		session: r.one.sessions({
			from: r.messages.sessionId,
			to: r.sessions.id
		}),
	},
	outputs: {
		session: r.one.sessions({
			from: r.outputs.sessionId,
			to: r.sessions.id
		}),
	},
}))