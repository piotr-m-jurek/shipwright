/**
 * Shared types for the live debug SSE stream.
 *
 * `DebugSnapshot` is emitted by the server as the `data` payload on every
 * `snapshot` SSE event and consumed by the frontend debug page.
 */

/**
 * Wire format of a debug snapshot — what the server emits as JSON in each
 * `snapshot` SSE event, and what the frontend parses. Dates are ISO strings
 * because they are produced by `JSON.stringify`.
 */
export interface DebugSnapshot {
  readonly session: {
    readonly id: string;
    readonly status: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly xstate: {
    readonly value: string;
    readonly round: number;
    readonly inputMode: string;
    readonly outputVersion: number;
    readonly documentSummaryCount: number;
    readonly questionCount: number;
    readonly answerCount: number;
    readonly revisionFeedback: string | null;
    readonly raw: unknown;
  } | null;
  readonly queue: ReadonlyArray<{
    readonly queue: string;
    readonly status: string;
    readonly attempts: number;
    readonly maxAttempts: number;
    readonly createdAt: string;
  }>;
  readonly documents: ReadonlyArray<{
    readonly id: string;
    readonly filename: string;
    readonly status: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly tokenCount: number | null;
  }>;
  readonly questions: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    readonly orderIndex: number;
  }>;
  readonly answers: ReadonlyArray<{
    readonly questionId: string;
    readonly text: string;
    readonly round: number;
  }>;
  readonly outputs: ReadonlyArray<{
    readonly type: string;
    readonly version: number | null;
    readonly createdAt: string;
    readonly contentLength: number;
  }>;
}
