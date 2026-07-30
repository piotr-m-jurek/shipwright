import { ShipwrightApi } from "@/store/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useState, useMemo } from "react";
import { Match, pipe } from "effect";
import { PostAgentSessionAnswersRequest } from "@shipwright/shared/schemas/api";
import { AgentSessionId } from "@shipwright/shared/domain/ids";

export const Route = createFileRoute("/sessions/$sessionId/questions")({
  component: RouteComponent,
});

function RouteComponent() {
  const { sessionId } = Route.useParams();
  return <QuestionsPage sessionId={AgentSessionId.make(sessionId)} />;
}

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

const sessionQueryFamily = Atom.family((sessionId: AgentSessionId) =>
  ShipwrightApi.query("compute", "getAgentSessionById", {
    params: { sessionId },
    reactivityKeys: ["session", sessionId],
    timeToLive: "30 seconds",
  }),
);

const submitAnswersFamily = Atom.family((_nonce: number) =>
  ShipwrightApi.mutation("results", "submitSessionAnswers"),
);

// ---------------------------------------------------------------------------
// Polling wrapper — refreshes every 2s while not awaiting_answers / complete
// ---------------------------------------------------------------------------

function useSessionPolling(sessionId: AgentSessionId) {
  const baseAtom = useMemo(() => sessionQueryFamily(sessionId), [sessionId]);
  const sessionResult = useAtomValue(baseAtom);

  const status = AsyncResult.isSuccess(sessionResult) ? sessionResult.value.status : null;

  const shouldPoll = status !== "awaiting_answers" && status !== "complete";

  const pollingAtom = useMemo(
    () => (shouldPoll ? Atom.withRefresh(baseAtom, "2 seconds") : baseAtom),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shouldPoll],
  );

  return useAtomValue(pollingAtom);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function QuestionsPage({ sessionId }: { sessionId: AgentSessionId }) {
  const sessionResult = useSessionPolling(sessionId);

  return pipe(
    Match.value(sessionResult),
    Match.when(
      (r) => AsyncResult.isWaiting(r) && !AsyncResult.isSuccess(r),
      () => (
        <div className="flex min-h-svh flex-col items-center justify-center gap-3">
          <Spinner className="size-5" />
          <p className="text-xs text-muted-foreground">Loading session…</p>
        </div>
      ),
    ),
    Match.when(AsyncResult.isFailure, () => (
      <div className="flex min-h-svh flex-col items-center justify-center gap-3">
        <Alert variant="destructive" className="max-w-xs">
          <AlertDescription>Failed to load session.</AlertDescription>
        </Alert>
      </div>
    )),
    Match.when(AsyncResult.isSuccess, ({ value: session }) => {
      if (session.status === "complete") {
        return <Navigate to={"/sessions/$sessionId/output"} params={{ sessionId }} />;
      }
      if (session.status === "awaiting_answers" && session.questions.length > 0) {
        return (
          <AnswerForm
            sessionId={sessionId}
            questions={[...session.questions].sort((a, b) => a.orderIndex - b.orderIndex)}
          />
        );
      }
      return (
        <div className="flex min-h-svh flex-col items-center justify-center gap-3">
          <Spinner className="size-5" />
          <p className="text-xs text-muted-foreground">{statusLabel(session.status)}</p>
        </div>
      );
    }),
    Match.orElse(() => null),
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "uploading":
      return "Uploading documents…";
    case "processing":
      return "Processing documents…";
    case "summarizing":
      return "Summarising documents…";
    case "analyzing":
      return "Analysing for gaps and contradictions…";
    case "generating":
      return "Generating outputs…";
    case "revising":
      return "Revising outputs…";
    default:
      return `Working… (${status})`;
  }
}

// ---------------------------------------------------------------------------
// Answer form
// ---------------------------------------------------------------------------

type Question = {
  id: string;
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
