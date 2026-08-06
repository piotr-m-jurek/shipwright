/**
 * Shared types for the session questions SSE stream.
 *
 * `SessionQuestionsSnapshot` is emitted by the server as the `data` payload on
 * every `snapshot` SSE event at GET /api/sessions/:sessionId/questions/stream
 * and consumed by the frontend questions page.
 */

/**
 * Wire format of a questions snapshot — what the server emits as JSON in each
 * `snapshot` SSE event. Dates are ISO strings because they are produced by
 * `JSON.stringify`.
 */
export interface SessionQuestionsSnapshot {
  readonly status: string;
  readonly inputMode: string;
  readonly errorReason: string | null;
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    readonly rationale: string;
    readonly sourceDocuments: ReadonlyArray<string>;
    readonly orderIndex: number;
  }>;
}
