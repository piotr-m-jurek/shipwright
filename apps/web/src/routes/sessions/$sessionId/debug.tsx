/**
 * Live debug view — /sessions/$sessionId/debug
 *
 * Connects to the SSE stream at /api/sessions/:sessionId/debug/stream and
 * renders the latest snapshot in real time.
 *
 * Developer tool — no link to it from the main app; visit the URL directly.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { DebugSnapshot } from "@shipwright/shared/schemas/debug";

export const Route = createFileRoute("/sessions/$sessionId/debug")({
  component: RouteComponent,
});

function RouteComponent() {
  const { sessionId } = Route.useParams();
  return <DebugPage sessionId={sessionId} />;
}

// ---------------------------------------------------------------------------
// SSE hook
// ---------------------------------------------------------------------------

type Status = "connecting" | "live" | "closed" | "error";

function useDebugStream(sessionId: string) {
  const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // Hit the API directly in dev to bypass Vite proxy buffering.
    const origin = import.meta.env.DEV ? "http://localhost:3000" : "";
    const url = `${origin}/api/sessions/${sessionId}/debug/stream`;

    const es = new EventSource(url, { withCredentials: true });
    esRef.current = es;

    es.addEventListener("open", () => setStatus("live"));

    es.addEventListener("snapshot", (e: MessageEvent) => {
      try {
        setSnapshot(JSON.parse(e.data) as DebugSnapshot);
        setStatus("live");
      } catch {
        // ignore malformed JSON
      }
    });

    es.addEventListener("error", () => {
      // Close immediately — don't let EventSource auto-reconnect on auth errors.
      es.close();
      setStatus(es.readyState === EventSource.CLOSED ? "closed" : "error");
    });

    return () => {
      es.close();
    };
  }, [sessionId]);

  return { snapshot, status };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function DebugPage({ sessionId }: { sessionId: string }) {
  const { snapshot, status } = useDebugStream(sessionId);
  const [showRaw, setShowRaw] = useState(false);

  console.log(snapshot, status);

  if (snapshot === null) {
    return (
      <div className="min-h-svh bg-background font-mono text-xs flex items-center justify-center gap-4">
        <span
          className={
            status === "error" || status === "closed" ? "text-red-500" : "text-muted-foreground"
          }
        >
          {status === "connecting" && "Connecting…"}
          {status === "error" && "Connection error — check auth cookie and session ID."}
          {status === "closed" && "Connection closed — check auth cookie and session ID."}
        </span>
      </div>
    );
  }

  return (
    <div className="min-h-svh bg-background font-mono text-xs p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border pb-2">
        <div className="space-y-0.5">
          <p className="text-sm font-medium tracking-tight">shipwright / debug</p>
          <p className="text-muted-foreground">{sessionId}</p>
        </div>
        <span className={status === "live" ? "text-green-500" : "text-muted-foreground"}>
          {status}
        </span>
      </div>

      <div className="space-y-6">
        {/* Session */}
        <Section title="session">
          <Row label="id" value={snapshot.session.id} />
          <Row label="status" value={snapshot.session.status} highlight />
          <Row label="createdAt" value={snapshot.session.createdAt} />
          <Row label="updatedAt" value={snapshot.session.updatedAt} />
        </Section>

        {/* XState */}
        {snapshot.xstate && (
          <Section title="xstate">
            <Row label="value" value={snapshot.xstate.value} highlight />
            <Row label="round" value={String(snapshot.xstate.round)} />
            <Row label="inputMode" value={snapshot.xstate.inputMode} />
            <Row label="outputVersion" value={String(snapshot.xstate.outputVersion)} />
            <Row label="documentSummaries" value={String(snapshot.xstate.documentSummaryCount)} />
            <Row label="questions" value={String(snapshot.xstate.questionCount)} />
            <Row label="answers" value={String(snapshot.xstate.answerCount)} />
            {snapshot.xstate.revisionFeedback && (
              <Row label="revisionFeedback" value={snapshot.xstate.revisionFeedback} />
            )}
          </Section>
        )}

        {/* Queue */}
        {snapshot.queue.length > 0 && (
          <Section title={`queue (${snapshot.queue.length})`}>
            {snapshot.queue.map((row, i) => (
              <div
                key={i}
                className="grid grid-cols-[auto_1fr] gap-x-4 border-b border-border/40 py-1 last:border-0"
              >
                <span className="text-muted-foreground">{row.queue}</span>
                <span>
                  <StatusBadge value={row.status} />{" "}
                  <span className="text-muted-foreground">
                    attempt {row.attempts}/{row.maxAttempts}
                  </span>
                </span>
              </div>
            ))}
          </Section>
        )}

        {/* Documents */}
        {snapshot.documents.length > 0 && (
          <Section title={`documents (${snapshot.documents.length})`}>
            {snapshot.documents.map((d) => (
              <div
                key={d.id}
                className="grid grid-cols-[auto_1fr] gap-x-4 border-b border-border/40 py-1 last:border-0"
              >
                <span className="text-muted-foreground truncate max-w-48">{d.filename}</span>
                <span className="flex gap-3">
                  <StatusBadge value={d.status} />
                  <span className="text-muted-foreground">
                    {(d.sizeBytes / 1024).toFixed(1)} KB
                    {d.tokenCount != null && ` · ${d.tokenCount} tok`}
                  </span>
                </span>
              </div>
            ))}
          </Section>
        )}

        {/* Questions */}
        {snapshot.questions.length > 0 && (
          <Section title={`questions (${snapshot.questions.length})`}>
            {snapshot.questions.map((q) => (
              <div key={q.id} className="border-b border-border/40 py-1 last:border-0">
                <span className="text-muted-foreground mr-2">{q.orderIndex}.</span>
                {q.text}
              </div>
            ))}
          </Section>
        )}

        {/* Answers */}
        {snapshot.answers.length > 0 && (
          <Section title={`answers (${snapshot.answers.length})`}>
            {snapshot.answers.map((a, i) => (
              <div key={i} className="border-b border-border/40 py-1 last:border-0">
                <span className="text-muted-foreground mr-2">round {a.round}</span>
                {a.text}
              </div>
            ))}
          </Section>
        )}

        {/* Outputs */}
        {snapshot.outputs.length > 0 && (
          <Section title={`outputs (${snapshot.outputs.length})`}>
            {snapshot.outputs.map((o, i) => (
              <div
                key={i}
                className="grid grid-cols-[auto_1fr] gap-x-4 border-b border-border/40 py-1 last:border-0"
              >
                <span className="text-muted-foreground">{o.type}</span>
                <span>
                  v{o.version ?? "?"} · {o.contentLength} chars
                </span>
              </div>
            ))}
          </Section>
        )}

        {/* Raw XState context */}
        {snapshot.xstate && (
          <div className="space-y-2">
            <button
              onClick={() => setShowRaw((v) => !v)}
              className="text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              {showRaw ? "hide" : "show"} raw xstate context
            </button>
            {showRaw && (
              <pre className="bg-muted rounded p-3 overflow-auto max-h-96 text-xs leading-relaxed">
                {JSON.stringify(snapshot.xstate.raw, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presentational helpers
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="uppercase tracking-widest text-[10px] text-muted-foreground pb-1 border-b border-border">
        {title}
      </p>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-x-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={highlight ? "font-semibold" : ""}>{value}</span>
    </div>
  );
}

const STATUS_COLOURS: Record<string, string> = {
  pending: "text-yellow-500",
  processing: "text-blue-500",
  done: "text-green-500",
  dead: "text-red-500",
  complete: "text-green-500",
  error: "text-red-500",
};

function StatusBadge({ value }: { value: string }) {
  return <span className={STATUS_COLOURS[value] ?? ""}>{value}</span>;
}
