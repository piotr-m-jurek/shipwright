import { ShipwrightApi } from "@/store/api";
import { sessionFilesAtomFamily } from "@/store/session-files";
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
import { Spinner } from "@/components/ui/spinner";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Effect } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { FileIcon, FileTextIcon, UploadSimpleIcon, XIcon } from "@phosphor-icons/react";
import { useState, useCallback, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { cn } from "@/lib/utils";
import { ConfirmUploadRequest, CreateAgentSessionRequest } from "@shipwright/shared/schemas/api";
import type { AgentSessionId } from "@shipwright/shared/domain/ids";

export const Route = createFileRoute("/")({
  component: RouteComponent,
});

function RouteComponent() {
  return <UploadPage />;
}

// ---------------------------------------------------------------------------
// Mutation atoms
// ---------------------------------------------------------------------------

const uploadUrlFamily = Atom.family((_nonce: number) =>
  ShipwrightApi.mutation("storage", "sessionUploadUrl"),
);

const confirmUploadFamily = Atom.family((_nonce: number) =>
  ShipwrightApi.mutation("storage", "confirmUpload"),
);

/**
 * Steps 1–3: get presigned URLs, PUT files to S3, confirm upload.
 * Stops before confirmAnalysis — that lives on the /confirm page.
 * Stores uploaded file metadata in sessionFilesAtomFamily for the confirm page.
 */
const handleUploadAtom = ShipwrightApi.runtime.fn<{
  files: File[];
  onDone: (sessionId: AgentSessionId) => void;
}>()(
  Effect.fnUntraced(function* ({ files, onDone }, ctx) {
    const nonce = Date.now();
    const uploadUrlAtom = uploadUrlFamily(nonce);
    const confirmUploadAtom = confirmUploadFamily(nonce);

    // 1. Get presigned S3 PUT URLs
    yield* Effect.log("[upload] 1/3 requesting presigned URLs", {
      nonce,
      fileCount: files.length,
    });
    const payload = CreateAgentSessionRequest.make({
      files: files.map((file) => ({
        filename: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
      })),
    });
    ctx.set(uploadUrlAtom, { payload });
    const { uploads, sessionId } = yield* ctx.result(uploadUrlAtom, { suspendOnWaiting: true });
    yield* Effect.log("[upload] 1/3 got presigned URLs", { sessionId });

    // 2. Upload directly to S3
    yield* Effect.log("[upload] 2/3 uploading to S3");
    yield* Effect.forEach(
      uploads,
      (upload, idx) =>
        Effect.gen(function* () {
          const res = yield* Effect.promise(() =>
            fetch(upload.presignedUrl, {
              method: "PUT",
              body: files[idx],
              headers: { "Content-Type": files[idx]!.type },
            }),
          );
          yield* Effect.log(`[upload] 2/3 PUT ${files[idx]?.name} → ${res.status}`);
        }),
      { concurrency: "unbounded" },
    );

    // 3. Confirm uploads landed in S3
    yield* Effect.log("[upload] 3/3 confirming upload", { sessionId });
    ctx.set(confirmUploadAtom, {
      params: { sessionId },
      payload: ConfirmUploadRequest.make({
        uploads: uploads.map((u) => ({ s3Key: u.s3Key, documentId: u.documentId })),
      }),
    });
    yield* ctx.result(confirmUploadAtom, { suspendOnWaiting: true });
    yield* Effect.log("[upload] 3/3 upload confirmed — navigating to confirm");

    // Store file metadata so the confirm page can display them
    ctx.set(
      sessionFilesAtomFamily(sessionId),
      files.map((f) => ({
        filename: f.name,
        mimeType: f.type,
        sizeBytes: f.size,
      })),
    );

    onDone(sessionId);
  }),
);

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function UploadPage() {
  const navigate = useNavigate();
  const triggerUpload = useAtomSet(handleUploadAtom);

  const handleUpload = (files: File[]) => {
    triggerUpload({
      files,
      onDone: (sessionId) =>
        navigate({ to: "/sessions/$sessionId/confirm", params: { sessionId } }),
    });
  };

  return <UploadForm onUpload={handleUpload} />;
}

// ---------------------------------------------------------------------------
// Upload form
// ---------------------------------------------------------------------------

function UploadForm({ onUpload }: { onUpload: (files: File[]) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const uploadResult = useAtomValue(handleUploadAtom);
  const isUploading = AsyncResult.isWaiting(uploadResult);

  useEffect(() => {
    console.log("[handleUploadAtom]", uploadResult._tag, {
      waiting: uploadResult.waiting,
      ...(AsyncResult.isSuccess(uploadResult) ? { value: uploadResult.value } : {}),
      ...(AsyncResult.isFailure(uploadResult) ? { cause: uploadResult.cause } : {}),
    });
  }, [uploadResult]);

  const onDrop = useCallback((accepted: File[]) => {
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.name));
      return [...prev, ...accepted.filter((f) => !existing.has(f.name))];
    });
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: true,
    disabled: isUploading,
  });

  const removeFile = (name: string) => setFiles((prev) => prev.filter((f) => f.name !== name));

  const handleSubmit = () => {
    if (files.length === 0 || isUploading) return;
    onUpload(files);
  };

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background p-8">
      <div className="w-full max-w-xl space-y-6">
        {/* Header */}
        <div className="space-y-1">
          <h1 className="font-mono text-sm font-medium tracking-tight">shipwright</h1>
          <p className="text-xs text-muted-foreground">
            Drop your project documents to begin analysis.
          </p>
        </div>

        {/* Drop zone */}
        <div
          {...getRootProps()}
          className={cn(
            "flex min-h-40 cursor-pointer flex-col items-center justify-center gap-3 border border-dashed p-8 transition-colors",
            isDragActive
              ? "border-foreground bg-muted/50"
              : "border-border hover:border-foreground/40 hover:bg-muted/20",
            isUploading && "pointer-events-none opacity-50",
          )}
        >
          <input {...getInputProps()} />
          <UploadSimpleIcon className="size-5 text-muted-foreground" />
          <p className="text-center text-xs text-muted-foreground">
            {isDragActive ? (
              "Drop files here"
            ) : (
              <>
                Drag files here, or{" "}
                <span className="text-foreground underline underline-offset-2">browse</span>
              </>
            )}
          </p>
          <p className="text-xs text-muted-foreground/60">
            PRDs, briefs, RFPs, transcripts — any text or PDF
          </p>
        </div>

        {/* File list */}
        {files.length > 0 && (
          <AttachmentGroup>
            {files.map((file) => (
              <Attachment key={file.name} state={isUploading ? "uploading" : "done"}>
                <AttachmentMedia>{fileIcon(file)}</AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>{file.name}</AttachmentTitle>
                  <AttachmentDescription>{formatBytes(file.size)}</AttachmentDescription>
                </AttachmentContent>
                {!isUploading && (
                  <AttachmentActions>
                    <AttachmentAction onClick={() => removeFile(file.name)}>
                      <XIcon />
                    </AttachmentAction>
                  </AttachmentActions>
                )}
              </Attachment>
            ))}
          </AttachmentGroup>
        )}

        {/* Submit */}
        <div className="flex items-center justify-between gap-4">
          {files.length > 0 && !isUploading && (
            <Button variant="ghost" size="sm" onClick={() => setFiles([])}>
              clear all
            </Button>
          )}
          <div className="ml-auto">
            <Button
              onClick={handleSubmit}
              disabled={files.length === 0 || isUploading}
              className="gap-2"
            >
              {isUploading ? (
                <>
                  <Spinner />
                  Uploading…
                </>
              ) : (
                `Upload${files.length > 0 ? ` ${files.length} file${files.length === 1 ? "" : "s"}` : ""}`
              )}
            </Button>
          </div>
        </div>

        {AsyncResult.isFailure(uploadResult) && (
          <Alert variant="destructive">
            <AlertDescription>Upload failed. Check your files and try again.</AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(file: File) {
  if (file.type.startsWith("text/") || file.name.endsWith(".md") || file.name.endsWith(".txt")) {
    return <FileTextIcon />;
  }
  return <FileIcon />;
}
