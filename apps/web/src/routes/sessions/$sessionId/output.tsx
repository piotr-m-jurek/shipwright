import { ShipwrightApi } from "@/store/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import { createFileRoute } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useState, useMemo, useEffect } from "react";
import { Match, pipe, Schema } from "effect";
import ReactMarkdown from "react-markdown";
import { ReviseRequest } from "@shipwright/shared/schemas/api";
import { DownloadSimpleIcon, ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";

// DB:
// - agentSessionID: ag_sesh_1234asdf

export const Route = createFileRoute("/sessions/$sessionId/output")({
  component: RouteComponent,
});

function RouteComponent() {
  const { sessionId } = Route.useParams();
  return <OutputPage sessionId={sessionId} />;
}

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

const outputQueryFamily = Atom.family((sessionId: AgentSessionId) =>
  ShipwrightApi.query("system", "getSessionFinalOutput", {
    params: { sessionId },
    reactivityKeys: ["session", sessionId, "output"],
    timeToLive: "30 seconds",
  }),
);

const downloadUrlFamily = Atom.family(
  ({ sessionId, type }: { sessionId: AgentSessionId; type: string }) =>
    ShipwrightApi.query("system", "getOutputDownloadUrl", {
      params: { sessionId, type },
    }),
);

const reviseFamily = Atom.family((_nonce: number) =>
  ShipwrightApi.mutation("system", "reviseOutput"),
);

function useOutputPolling(sessionId: AgentSessionId) {
  const outputAtom = useMemo(() => outputQueryFamily(sessionId), [sessionId]);
  const result = useAtomValue(outputAtom);

  const hasOutputs =
    AsyncResult.isSuccess(result) &&
    result.value.projectBrief !== null &&
    result.value.implementationPrd !== null;

  const pollingAtom = useMemo(
    () => (hasOutputs ? outputAtom : Atom.withRefresh(outputAtom, "3 seconds")),
    [hasOutputs],
  );
  return useAtomValue(pollingAtom);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function OutputPage({ sessionId }: { sessionId: AgentSessionId }) {
  const outputResult = useOutputPolling(sessionId);
  return pipe(
    Match.value(outputResult),
    Match.when(
      (r) => AsyncResult.isWaiting(r) && !AsyncResult.isSuccess(r),
      () => (
        <div className="flex min-h-svh flex-col items-center justify-center gap-3">
          <Spinner className="size-5" />
          <p className="text-xs text-muted-foreground">Loading outputs…</p>
        </div>
      ),
    ),
    Match.when(AsyncResult.isFailure, () => (
      <div className="flex min-h-svh flex-col items-center justify-center gap-3">
        <p className="text-xs text-destructive">Failed to load outputs.</p>
      </div>
    )),
    Match.when(AsyncResult.isSuccess, ({ value: { projectBrief, implementationPrd, version } }) => (
      <div className="flex min-h-svh flex-col bg-background">
        <header className="flex items-center justify-between border-b px-6 py-3">
          <div className="space-y-0.5">
            <h1 className="font-mono text-sm font-medium tracking-tight">shipwright</h1>
            {version != null && <p className="text-xs text-muted-foreground">Version {version}</p>}
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          {pipe(
            Match.value({ projectBrief, implementationPrd }),
            Match.when({ project: Match.null, implementationPrd: Match.null }, () => (
              <div className="flex min-h-svh flex-col items-center justify-center gap-3">
                <Spinner className="size-5" />
                <p className="text-xs text-muted-foreground">Generating outputs…</p>
              </div>
            )),
            Match.orElse(() => (
              <>
                <OutputPanel
                  title="Project Brief"
                  content={projectBrief}
                  downloadType="project_brief"
                  sessionId={sessionId}
                />
                <div className="w-px bg-border" />
                <OutputPanel
                  title="Implementation PRD"
                  content={implementationPrd}
                  downloadType="implementation_prd"
                  sessionId={sessionId}
                />
              </>
            )),
          )}
        </div>
        <RevisionSection sessionId={sessionId} />
      </div>
    )),
    Match.orElse(() => null),
  );
}

// ---------------------------------------------------------------------------
// Output panel
// ---------------------------------------------------------------------------

function OutputPanel({
  title,
  content,
  downloadType,
  sessionId,
}: {
  title: string;
  content: string | null;
  downloadType: string;
  sessionId: string;
}) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="font-mono text-xs font-medium">{title}</span>
        <DownloadButton sessionId={sessionId} type={downloadType} />
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {content ? (
          <article className="prose prose-sm prose-neutral dark:prose-invert max-w-none text-xs">
            <ReactMarkdown>{content}</ReactMarkdown>
          </article>
        ) : (
          <p className="text-xs text-muted-foreground">No content yet.</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Download button — fetches presigned URL on click
// ---------------------------------------------------------------------------

function DownloadButton({ sessionId, type }: { sessionId: AgentSessionId; type: string }) {
  const urlAtom = useMemo(() => downloadUrlFamily({ sessionId, type }), [sessionId, type]);
  const urlResult = useAtomValue(urlAtom);

  const handleDownload = () => {
    if (AsyncResult.isSuccess(urlResult)) {
      window.open(urlResult.value.url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={handleDownload}
      disabled={!AsyncResult.isSuccess(urlResult)}
      title={`Download ${type.replace("_", " ")}`}
    >
      {AsyncResult.isWaiting(urlResult) ? (
        <Spinner className="size-3" />
      ) : (
        <DownloadSimpleIcon className="size-3.5" />
      )}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Revision section
// ---------------------------------------------------------------------------

function RevisionSection({ sessionId }: { sessionId: AgentSessionId }) {
  const [feedback, setFeedback] = useState("");
  const [open, setOpen] = useState(false);
  const nonce = useMemo(() => Date.now(), []);
  const reviseAtom = useMemo(() => reviseFamily(nonce), [nonce]);
  const reviseResult = useAtomValue(reviseAtom);
  const revise = useAtomSet(reviseAtom);
  const isRevising = AsyncResult.isWaiting(reviseResult);

  // After revision starts, invalidate the output query so it re-fetches
  useEffect(() => {
    if (AsyncResult.isSuccess(reviseResult)) {
      setOpen(false);
      setFeedback("");
    }
  }, [reviseResult]);

  const handleRevise = () => {
    if (!feedback.trim() || isRevising) return;
    revise({
      params: { sessionId },
      payload: ReviseRequest.make({ feedback }),
      reactivityKeys: { session: [sessionId, "output"] },
    });
  };

  return (
    <div className="border-t px-6 py-4">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          <ArrowCounterClockwiseIcon className="size-3.5" />
          Request revision
        </button>
      ) : (
        <div className="space-y-3">
          <p className="text-xs font-medium">Revision feedback</p>
          <Textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Describe what to change or improve…"
            disabled={isRevising}
            className="min-h-20 resize-none"
          />
          <div className="flex items-center justify-between gap-4">
            {AsyncResult.isFailure(reviseResult) && (
              <p className="text-xs text-destructive">Revision failed. Try again.</p>
            )}
            <div className="ml-auto flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOpen(false);
                  setFeedback("");
                }}
                disabled={isRevising}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleRevise}
                disabled={!feedback.trim() || isRevising}
                className="gap-2"
              >
                {isRevising ? (
                  <>
                    <Spinner />
                    Revising…
                  </>
                ) : (
                  "Submit revision"
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
