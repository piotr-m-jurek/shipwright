import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ShipwrightApi } from "@/store/api";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useState, useMemo, useEffect, useRef } from "react";
import { Match, pipe } from "effect";
import { PostAgentSessionAnswersRequest } from "@shipwright/shared/schemas/api";
import { AgentSessionId, type QuestionId } from "@shipwright/shared/domain/ids";
import type { SessionQuestionsSnapshot } from "@shipwright/shared/schemas/questions";

export const Route = createFileRoute("/sessions/$sessionId/questions")({
  component: RouteComponent,
});

function RouteComponent() {
  const { sessionId } = Route.useParams();
  return <QuestionsPage sessionId={AgentSessionId.make(sessionId)} />;
}

// ---------------------------------------------------------------------------
// Atoms — mutations only; session state comes from SSE
// ---------------------------------------------------------------------------

const submitAnswersFamily = Atom.family((_nonce: number) =>
  ShipwrightApi.mutation("results", "submitSessionAnswers"),
);

const retrySessionFamily = Atom.family((_nonce: number) =>
  ShipwrightApi.mutation("storage", "retrySession"),
);

// ---------------------------------------------------------------------------
// Pipeline steps — order matters
// ---------------------------------------------------------------------------

type PipelineStep = {
  status: string;
  label: string;
  description: string;
};

const PIPELINE_STEPS: PipelineStep[] = [
  { status: "uploading",              label: "Upload",    description: "Receiving documents" },
  { status: "waiting_for_documents",  label: "Upload",    description: "Processing documents…" },
  { status: "summarizing",            label: "Summarise", description: "Reading and summarising content" },
  { status: "processing",       label: "Process",   description: "Chunking and indexing" },
  { status: "analyzing",        label: "Analyse",   description: "Finding gaps and contradictions" },
  { status: "awaiting_answers", label: "Questions", description: "Ready for your input" },
  { status: "re_evaluating",    label: "Evaluate",  description: "Reviewing your answers" },
  { status: "generating",       label: "Generate",  description: "Writing outputs" },
];

const ERROR_STATUS_LABELS: Record<string, string> = {
  uploading_error:     "Upload failed",
  summarizing_error:   "Summarisation failed",
  processing_error:    "Processing failed",
  analyzing_error:     "Analysis failed",
  re_evaluating_error: "Re-evaluation failed",
  generating_error:    "Generation failed",
  revising_error:      "Revision failed",
  error:               "An error occurred",
  partial_error:       "Some documents could not be processed",
};

function isErrorStatus(status: string): boolean {
  return status in ERROR_STATUS_LABELS || status === "error" || status === "partial_error";
}

function stepIndexForStatus(status: string): number {
  return PIPELINE_STEPS.findIndex((s) => s.status === status);
}

// ---------------------------------------------------------------------------
// SSE hook — replaces polling
// ---------------------------------------------------------------------------

type StreamStatus = "connecting" | "live" | "closed" | "error";

function useSessionStream(sessionId: AgentSessionId) {
  const [snapshot, setSnapshot] = useState<SessionQuestionsSnapshot | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("connecting");
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // Hit the API directly in dev to bypass Vite proxy buffering.
    const origin = import.meta.env.DEV ? "http://localhost:3000" : "";
    const url = `${origin}/api/sessions/${sessionId}/questions/stream`;

    const es = new EventSource(url, { withCredentials: true });
    esRef.current = es;

    es.addEventListener("open", () => setStreamStatus("live"));

    es.addEventListener("snapshot", (e: MessageEvent) => {
      try {
        setSnapshot(JSON.parse(e.data) as SessionQuestionsSnapshot);
        setStreamStatus("live");
      } catch {
        // ignore malformed JSON
      }
    });

    es.addEventListener("error", () => {
      // Close immediately — don't let EventSource auto-reconnect on auth errors.
      es.close();
      setStreamStatus(es.readyState === EventSource.CLOSED ? "closed" : "error");
    });

    return () => {
      es.close();
    };
  }, [sessionId]);

  return { snapshot, streamStatus };
}

// ---------------------------------------------------------------------------
// Progress stepper
// ---------------------------------------------------------------------------

function PipelineProgress({ status }: { status: string }) {
  const currentIdx = stepIndexForStatus(status);

  return (
    <div className="w-full max-w-sm space-y-4">
      <ol className="space-y-2">
        {PIPELINE_STEPS.map((step, idx) => {
          const isDone    = idx < currentIdx;
          const isActive  = idx === currentIdx;
          const isPending = idx > currentIdx;

          return (
            <li key={step.status} className="flex items-start gap-3">
              {/* Step indicator */}
              <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
                {isDone ? (
                  <svg
                    className="size-4 text-foreground"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <polyline points="3,8 6.5,12 13,4" />
                  </svg>
                ) : isActive ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <span className="size-1.5 rounded-full bg-muted-foreground/30" />
                )}
              </div>

              {/* Step text */}
              <div className={isPending ? "opacity-35" : ""}>
                <p className={`text-xs font-medium ${isActive ? "" : isDone ? "line-through opacity-50" : ""}`}>
                  {step.label}
                </p>
                {isActive && (
                  <p className="text-xs text-muted-foreground">{step.description}…</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error display
// ---------------------------------------------------------------------------

function PipelineError({
  status,
  errorReason,
  sessionId,
}: {
  status: string;
  errorReason: string | null;
  sessionId: AgentSessionId;
}) {
  const isEmbeddingUnavailable = errorReason === "embedding_unavailable";
  const message = isEmbeddingUnavailable
    ? "Document processing service is unavailable."
    : (ERROR_STATUS_LABELS[status] ?? "Something went wrong");

  const failedBase = status.replace(/_error$/, "");
  const failedStep = PIPELINE_STEPS.find((s) => s.status === failedBase);

  const nonce = useMemo(() => Date.now(), []);
  const retryAtom = useMemo(() => retrySessionFamily(nonce), [nonce]);
  const retryResult = useAtomValue(retryAtom);
  const retry = useAtomSet(retryAtom);

  const isRetrying = AsyncResult.isWaiting(retryResult);

  return (
    <div className="w-full max-w-sm space-y-4">
      <Alert variant="destructive">
        <AlertDescription className="space-y-1">
          <p className="font-medium">{message}</p>
          {!isEmbeddingUnavailable && failedStep && (
            <p className="text-xs opacity-80">Failed during: {failedStep.label}</p>
          )}
          {!isEmbeddingUnavailable && (
            <p className="text-xs opacity-70 pt-1">
              Check server logs or contact support if this persists.
            </p>
          )}
        </AlertDescription>
      </Alert>
      {isEmbeddingUnavailable && (
        <Button
          onClick={() => retry({ params: { sessionId }, reactivityKeys: ["session", sessionId] })}
          disabled={isRetrying}
          className="w-full gap-2"
        >
          {isRetrying ? <><Spinner />Retrying…</> : "Retry"}
        </Button>
      )}
      <a href="/" className="block text-center text-xs text-muted-foreground underline underline-offset-2">
        Start a new session
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function QuestionsPage({ sessionId }: { sessionId: AgentSessionId }) {
  const { snapshot, streamStatus } = useSessionStream(sessionId);

  // While connecting and no snapshot yet — show loading
  if (snapshot === null) {
    if (streamStatus === "error" || streamStatus === "closed") {
      return (
        <div className="flex min-h-svh flex-col items-center justify-center gap-6">
          <p className="font-mono text-sm font-medium tracking-tight">shipwright</p>
          <Alert variant="destructive" className="max-w-sm">
            <AlertDescription>
              Failed to connect to session stream. Check your connection and reload.
            </AlertDescription>
          </Alert>
        </div>
      );
    }

    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-6">
        <p className="font-mono text-sm font-medium tracking-tight">shipwright</p>
        <Spinner className="size-4" />
        <p className="text-xs text-muted-foreground">Loading session…</p>
      </div>
    );
  }

  const { status, errorReason, questions } = snapshot;

  if (status === "complete") {
    return <Navigate to={"/sessions/$sessionId/output"} params={{ sessionId }} />;
  }

  if (status === "awaiting_answers" && questions.length > 0) {
    return (
      <AnswerForm
        sessionId={sessionId}
        questions={[...questions]
          .sort((a, b) => a.orderIndex - b.orderIndex)
          .map((q) => ({ ...q, id: q.id as QuestionId }))}
      />
    );
  }

  if (isErrorStatus(status)) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-6">
        <p className="font-mono text-sm font-medium tracking-tight">shipwright</p>
        <PipelineError status={status} errorReason={errorReason} sessionId={sessionId} />
      </div>
    );
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6">
      <p className="font-mono text-sm font-medium tracking-tight">shipwright</p>
      <PipelineProgress status={status} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Answer form
// ---------------------------------------------------------------------------

type Question = {
  id: QuestionId;
  text: string;
  rationale: string;
  sourceDocuments: readonly string[];
  orderIndex: number;
};

function AnswerForm({
  sessionId,
  questions,
}: {
  sessionId: AgentSessionId;
  questions: Question[];
}) {
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, ""])),
  );
  const nonce = useMemo(() => Date.now(), []);
  const submitAtom = useMemo(() => submitAnswersFamily(nonce), [nonce]);
  const submitResult = useAtomValue(submitAtom);
  const submit = useAtomSet(submitAtom);

  const isSubmitting = AsyncResult.isWaiting(submitResult);

  const handleSubmit = () => {
    const payload = PostAgentSessionAnswersRequest.make({
      answers: questions.map((q) => ({
        questionId: q.id,
        text: answers[q.id] ?? "",
      })),
    });
    submit({
      params: { sessionId },
      payload,
      reactivityKeys: ["session", sessionId],
    });
  };

  const allAnswered = questions.every((q) => (answers[q.id] ?? "").trim().length > 0);

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background p-8">
      <div className="w-full max-w-2xl space-y-8">
        {/* Header */}
        <div className="space-y-1">
          <h1 className="font-mono text-sm font-medium tracking-tight">shipwright</h1>
          <p className="text-xs text-muted-foreground">
            Answer the following questions to help refine the analysis.
          </p>
        </div>

        {/* Questions */}
        <div className="space-y-6">
          {questions.map((question, idx) => (
            <Field key={question.id}>
              <FieldLabel className="font-medium">
                {idx + 1}. {question.text}
              </FieldLabel>
              {question.rationale && (
                <FieldDescription className="italic opacity-70">
                  {question.rationale}
                </FieldDescription>
              )}
              {question.sourceDocuments.length > 0 && (
                <FieldDescription className="opacity-50">
                  Source: {question.sourceDocuments.join(", ")}
                </FieldDescription>
              )}
              <Textarea
                value={answers[question.id] ?? ""}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [question.id]: e.target.value }))}
                placeholder="Your answer…"
                disabled={isSubmitting}
                className="min-h-20 resize-none"
              />
            </Field>
          ))}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-4">
          {AsyncResult.isFailure(submitResult) && (
            <Alert variant="destructive">
              <AlertDescription>Submission failed. Try again.</AlertDescription>
            </Alert>
          )}
          <Button onClick={handleSubmit} disabled={!allAnswered || isSubmitting} className="gap-2">
            {isSubmitting ? (
              <>
                <Spinner />
                Submitting…
              </>
            ) : (
              "Submit answers"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
