import { fileTypeFromBuffer } from "file-type";
import { extractText, getDocumentProxy } from "unpdf";
import { extractRawText } from "mammoth";
import path from "node:path";
import { PDF_PAGES_SEPARATOR } from "./index.js";
import { Effect, Match, pipe, Schema } from "effect";
import { StorageAdapter } from "../storage/index.js";

export type ParsedFileType = "markdown" | "pdf" | "plain-text" | "docx";

export type ParseResult = (
  | { type: Extract<ParsedFileType, "pdf">; pages: string[] }
  | { type: Exclude<ParsedFileType, "pdf"> }
) & { text: string; filename: string };

class UnknownFileExtension extends Schema.TaggedErrorClass<UnknownFileExtension>()(
  "UnknownFileExtension",
  { cause: Schema.Defect(), message: Schema.optional(Schema.String) },
) {}

class PdfParseError extends Schema.TaggedErrorClass<PdfParseError>()("PdfParseError", {
  cause: Schema.Defect(),
}) {}

class DocParseError extends Schema.TaggedErrorClass<DocParseError>()("DocParseError", {
  cause: Schema.Defect(),
}) {}

class UnsupportedFileTypeError extends Schema.TaggedErrorClass<UnsupportedFileTypeError>()(
  "UnsupportedFileTypeError",
  { filetype: Schema.optional(Schema.String) },
) {}

export class MimeVerificationError extends Schema.TaggedErrorClass<MimeVerificationError>()(
  "MimeVerificationError",
  {
    filename: Schema.String,
    claimedExt: Schema.String,
    detectedExt: Schema.optional(Schema.String),
  },
) {}

/** Expected content-based extension for each supported file extension. */
const EXPECTED_CONTENT_EXT: Record<string, string | null> = {
  ".pdf": "pdf",
  ".docx": "docx",
  // plain text and markdown have no magic bytes — file-type returns undefined
  ".txt": null,
  ".md": null,
};

/**
 * Downloads the first N bytes of `s3Key` and uses `fileTypeFromStream` to
 * verify the actual MIME type matches the claimed file extension.
 * Fails with `MimeVerificationError` when they don't match.
 */
export const verifyFileMimeType = Effect.fn("agent/verify-file-mime-type")(function* (
  s3Key: string,
  filename: string,
) {
  const storage = yield* StorageAdapter;
  const filenameExt = path.extname(filename).toLowerCase();
  const expectedContentExt = EXPECTED_CONTENT_EXT[filenameExt];

  // For plain text / markdown, no magic bytes exist — skip content check.
  if (expectedContentExt === null) {
    return;
  }

  // 4100 bytes is the recommended sample size for file-type detection
  const bytes = yield* storage.downloadPartialObject(s3Key, 4100);

  const detected = yield* Effect.tryPromise({
    try: () => fileTypeFromBuffer(bytes),
    catch: (cause) =>
      new MimeVerificationError({
        filename,
        claimedExt: filenameExt,
        detectedExt: String(cause),
      }),
  });

  if (detected?.ext !== expectedContentExt) {
    return yield* new MimeVerificationError({
      filename,
      claimedExt: filenameExt,
      detectedExt: detected?.ext,
    });
  }
});

const getExtension = (filename: string) =>
  pipe(
    Effect.try({
      try: () => path.extname(filename),
      catch: (cause) => new UnknownFileExtension({ cause }),
    }),
    Effect.filterOrFail(
      (ext) => ext.length > 0,
      () =>
        new UnknownFileExtension({
          message: `Could not match extension of file: ${filename}`,
          cause: "",
        }),
    ),
    Effect.withSpan("agent/get-extension"),
  );

const getPdfParseResult = (
  buffer: Buffer,
  filename: string,
): Effect.Effect<ParseResult, PdfParseError> =>
  pipe(
    Effect.tryPromise({
      try: () => getDocumentProxy(new Uint8Array(buffer)),
      catch: (cause) => new PdfParseError({ cause }),
    }),
    Effect.flatMap((raw) =>
      Effect.tryPromise({
        try: () => extractText(raw),
        catch: (cause) => new PdfParseError({ cause }),
      }),
    ),
    Effect.map(
      (extracted) =>
        ({
          type: "pdf",
          pages: extracted.text,
          filename,
          text: extracted.text.join(PDF_PAGES_SEPARATOR),
        }) satisfies ParseResult,
    ),
  );

const getDocParseResult = (buffer: Buffer, filename: string) =>
  pipe(
    Effect.tryPromise({
      try: () => extractRawText({ buffer }),
      catch: (cause) => new DocParseError({ cause }),
    }),
    Effect.map((rawText) => ({ type: "docx" as const, text: rawText.value, filename })),
  );

export const parseDocument = Effect.fn("agent/parse-document")(function* (
  buffer: Buffer,
  filename: string,
): Effect.fn.Return<
  ParseResult,
  UnknownFileExtension | PdfParseError | DocParseError | UnsupportedFileTypeError
> {
  const filenameExt = yield* getExtension(filename);

  return yield* Match.value(filenameExt).pipe(
    Match.when(".md", () =>
      Effect.succeed({ type: "markdown" as const, text: buffer.toString("utf-8"), filename }),
    ),
    Match.when(".txt", () =>
      Effect.succeed({ type: "plain-text" as const, text: buffer.toString("utf-8"), filename }),
    ),
    Match.when(".pdf", () => getPdfParseResult(buffer, filename)),
    Match.when(".docx", () => getDocParseResult(buffer, filename)),
    Match.orElse((ext) => Effect.fail(new UnsupportedFileTypeError({ filetype: ext }))),
  );
});
