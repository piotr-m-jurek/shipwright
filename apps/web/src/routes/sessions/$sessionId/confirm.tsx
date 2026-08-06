import { ShipwrightApi } from "@/store/api";
import { sessionFilesAtomFamily, type UploadedFileMeta } from "@/store/session-files";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { Effect } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { FileIcon, FileTextIcon, UploadSimpleIcon, XIcon } from "@phosphor-icons/react";
import { useState, useCallback, useEffect, useMemo } from "react";
import { useDropzone } from "react-dropzone";
import { cn } from "@/lib/utils";
import { ConfirmUploadRequest, CreateAgentSessionRequest } from "@shipwright/shared/schemas/api";
import { AgentSessionId } from "@shipwright/shared/domain/ids";
import { formatBytes } from "@/lib/format-bytes";

export const Route = createFileRoute("/sessions/$sessionId/confirm")({
  component: RouteComponent,
});

function RouteComponent() {
  const { sessionId } = Route.useParams();
  return <ConfirmPage sessionId={AgentSessionId.make(sessionId)} />;
}

// ---------------------------------------------------------------------------
// Query atoms
// ---------------------------------------------------------------------------

const sessionDocumentsFamily = Atom.family((sessionId: AgentSessionId) =>
  ShipwrightApi.query("compute", "getSessionDocuments", {
    params: { sessionId },
    reactivityKeys: ["session-documents", sessionId],
  }),
);

// ---------------------------------------------------------------------------
// Mutation atoms
// ---------------------------------------------------------------------------

const additionalUploadUrlFamily = Atom.family((_nonce: number) =>
  ShipwrightApi.mutation("storage", "sessionUploadUrl"),
);

const additionalConfirmUploadFamily = Atom.family((_nonce: number) =>
  ShipwrightApi.mutation("storage", "confirmUpload"),
);

const confirmAnalysisFamily = Atom.family((_nonce: number) =>
  ShipwrightApi.mutation("compute", "confirmAnalysis"),
);

/**
 * Uploads additional files, creates a second session for them, confirms that
 * upload, then records the file metadata locally.
 *
 * Limitation: the API creates one session per upload-url call. Additional
 * files land in a separate session that won't be linked to the original for
 * analysis. This section is therefore intentionally scope-limited: it lets
 * the user upload more files, records them as "also uploaded", but the
 * analysis confirmation uses the original sessionId.
 *
 * A future API addition (POST /sessions/:id/documents) would unify this.
 */
const addFilesAtom = ShipwrightApi.runtime.fn<{
  files: File[];
  onDone: (added: UploadedFileMeta[], newSessionId: AgentSessionId) => void;
}>()(
  Effect.fnUntraced(function* ({ files, onDone }, ctx) {
    const nonce = Date.now();
    const uploadUrlAtom = additionalUploadUrlFamily(nonce);
    const confirmUploadAtom = additionalConfirmUploadFamily(nonce);

    ctx.set(uploadUrlAtom, {
      payload: CreateAgentSessionRequest.make({
        files: files.map((f) => ({ filename: f.name, mimeType: f.type, sizeBytes: f.size })),
      }),
    });
    const { uploads, sessionId: newSessionId } = yield* ctx.result(uploadUrlAtom, {
      suspendOnWaiting: true,
    });

    yield* Effect.forEach(
      uploads,
      (upload, idx) =>
        Effect.promise(() =>
          fetch(upload.presignedUrl, {
            method: "PUT",
            body: files[idx],
            headers: { "Content-Type": files[idx]!.type },
          }),
        ),
      { concurrency: "unbounded" },
    );

    ctx.set(confirmUploadAtom, {
      params: { sessionId: newSessionId },
      payload: ConfirmUploadRequest.make({
        uploads: uploads.map((u) => ({ s3Key: u.s3Key, documentId: u.documentId })),
      }),
    });
    yield* ctx.result(confirmUploadAtom, { suspendOnWaiting: true });

    onDone(
      files.map((f) => ({ filename: f.name, mimeType: f.type, sizeBytes: f.size })),
      newSessionId,
    );
  }),
);

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function ConfirmPage({ sessionId }: { sessionId: AgentSessionId }) {
  const navigate = useNavigate();
  const [uploadedFiles, setUploadedFiles] = useAtom(sessionFilesAtomFamily(sessionId));

  // Fetch documents from the API to recover state after a page refresh.
  const documentsResult = useAtomValue(useMemo(() => sessionDocumentsFamily(sessionId), [sessionId]));

  // Seed the in-memory atom from the API response when it's empty (e.g. after refresh).
  useEffect(() => {
    if (uploadedFiles.length === 0 && AsyncResult.isSuccess(documentsResult)) {
      const fromApi = documentsResult.value.documents.map((d) => ({
        filename: d.filename,
        mimeType: d.mimeType,
        sizeBytes: d.sizeBytes,
      }));
      if (fromApi.length > 0) setUploadedFiles(fromApi);
    }
  }, [documentsResult, uploadedFiles.length, setUploadedFiles]);

  const nonce = useMemo(() => Date.now(), []);
  const confirmAtom = useMemo(() => confirmAnalysisFamily(nonce), [nonce]);
  const confirmResult = useAtomValue(confirmAtom);
  const confirm = useAtomSet(confirmAtom);

  const isConfirming = AsyncResult.isWaiting(confirmResult);

  useEffect(() => {
    if (AsyncResult.isSuccess(confirmResult)) {
      navigate({ to: "/sessions/$sessionId/questions", params: { sessionId } });
    }
  }, [confirmResult, sessionId, navigate]);

  const handleStartAnalysis = () => {
    confirm({ params: { sessionId } });
  };

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background p-8">
      <div className="w-full max-w-xl space-y-6">
        {/* Header */}
        <div className="space-y-1">
          <h1 className="font-mono text-sm font-medium tracking-tight">shipwright</h1>
          <p className="text-xs text-muted-foreground">
            Review your files, add more if needed, then start analysis.
          </p>
        </div>

        {/* Already-uploaded files */}
        {uploadedFiles.length > 0 && (
          <div className="space-y-2">
            <Label className="text-muted-foreground">Uploaded</Label>
            <AttachmentGroup>
              {uploadedFiles.map((file) => (
                <Attachment key={file.filename} state="done">
                  <AttachmentMedia>{fileMetaIcon(file)}</AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle>{file.filename}</AttachmentTitle>
                    <AttachmentDescription>{formatBytes(file.sizeBytes)}</AttachmentDescription>
                  </AttachmentContent>
                </Attachment>
              ))}
            </AttachmentGroup>
          </div>
        )}

        {/* Add more files */}
        <AdditionalUploadSection
          disabled={isConfirming}
          onAdded={(added) =>
            setUploadedFiles((prev) => {
              const existing = new Set(prev.map((f) => f.filename));
              return [...prev, ...added.filter((f) => !existing.has(f.filename))];
            })
          }
        />

        {/* Actions */}
        <div className="flex items-center justify-between gap-4">
          <Link
            to="/"
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            start over
          </Link>
          <div className="flex items-center gap-3">
            {AsyncResult.isFailure(confirmResult) && (
              <Alert variant="destructive">
                <AlertDescription>Failed to start. Try again.</AlertDescription>
              </Alert>
            )}
            <Button
              onClick={handleStartAnalysis}
              disabled={
                (uploadedFiles.length === 0 && !AsyncResult.isSuccess(documentsResult)) ||
                isConfirming
              }
              className="gap-2"
            >
              {isConfirming ? (
                <>
                  <Spinner />
                  Starting…
                </>
              ) : (
                "Start analysing"
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Additional upload section
// ---------------------------------------------------------------------------

function AdditionalUploadSection({
  disabled,
  onAdded,
}: {
  disabled: boolean;
  onAdded: (files: UploadedFileMeta[]) => void;
}) {
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const addResult = useAtomValue(addFilesAtom);
  const addFiles = useAtomSet(addFilesAtom);
  const isUploading = AsyncResult.isWaiting(addResult);
  const isDisabled = disabled || isUploading;

  const onDrop = useCallback((accepted: File[]) => {
    setPendingFiles((prev) => {
      const existing = new Set(prev.map((f) => f.name));
      return [...prev, ...accepted.filter((f) => !existing.has(f.name))];
    });
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: true,
    disabled: isDisabled,
  });

  const removeFile = (name: string) =>
    setPendingFiles((prev) => prev.filter((f) => f.name !== name));

  const handleUpload = () => {
    if (pendingFiles.length === 0 || isUploading) return;
    addFiles({
      files: pendingFiles,
      onDone: (added) => {
        setPendingFiles([]);
        onAdded(added);
      },
    });
  };

  return (
    <div className="space-y-3">
      <div
        {...getRootProps()}
        className={cn(
          "flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 border border-dashed p-6 transition-colors",
          isDragActive
            ? "border-foreground bg-muted/50"
            : "border-border hover:border-foreground/40 hover:bg-muted/20",
          isDisabled && "pointer-events-none opacity-50",
        )}
      >
        <input {...getInputProps()} />
        <UploadSimpleIcon className="size-4 text-muted-foreground" />
        <p className="text-center text-xs text-muted-foreground">
          {isDragActive ? (
            "Drop files here"
          ) : (
            <>
              Add more files, or{" "}
              <span className="text-foreground underline underline-offset-2">browse</span>
            </>
          )}
        </p>
      </div>

      {pendingFiles.length > 0 && (
        <>
          <AttachmentGroup>
            {pendingFiles.map((file) => (
              <Attachment key={file.name} state={isUploading ? "uploading" : "idle"}>
                <AttachmentMedia>{fileIcon(file)}</AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>{file.name}</AttachmentTitle>
                  <AttachmentDescription>{formatBytes(file.size)}</AttachmentDescription>
                </AttachmentContent>
                {!isUploading && (
                  <AttachmentActions>
                    <AttachmentAction onClick={() => removeFile(file.name)}>
                      <XIcon className="size-3.5" />
                    </AttachmentAction>
                  </AttachmentActions>
                )}
              </Attachment>
            ))}
          </AttachmentGroup>

          <div className="flex items-center justify-end gap-3">
            {AsyncResult.isFailure(addResult) && (
              <Alert variant="destructive">
                <AlertDescription>Upload failed. Try again.</AlertDescription>
              </Alert>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleUpload}
              disabled={isDisabled}
              className="gap-2"
            >
              {isUploading ? (
                <>
                  <Spinner />
                  Uploading…
                </>
              ) : (
                `Upload ${pendingFiles.length} more`
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileIcon(file: File) {
  if (file.type.startsWith("text/") || file.name.endsWith(".md") || file.name.endsWith(".txt")) {
    return <FileTextIcon />;
  }
  return <FileIcon />;
}

function fileMetaIcon(file: UploadedFileMeta) {
  if (
    file.mimeType.startsWith("text/") ||
    file.filename.endsWith(".md") ||
    file.filename.endsWith(".txt")
  ) {
    return <FileTextIcon />;
  }
  return <FileIcon />;
}
