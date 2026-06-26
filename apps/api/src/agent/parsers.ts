import { fileTypeFromBuffer } from "file-type";
import { extractText, getDocumentProxy } from "unpdf";
import { extractRawText } from "mammoth";
import path from "node:path";
import { PDF_PAGES_SEPARATOR } from "./index.js";
import { Effect, Match, pipe, Schema } from "effect";

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
  const fileType = yield* Effect.tryPromise({
    try: () => fileTypeFromBuffer(buffer),
    catch: (cause) =>
      new UnknownFileExtension({
        cause,
        message: `Could not read fileType from buffer ${buffer}`,
      }),
  });

  return yield* Match.value({ filenameExt, fileTypeExt: fileType?.ext }).pipe(
    Match.when({ filenameExt: ".md" }, () =>
      Effect.succeed({ type: "markdown" as const, text: buffer.toString("utf-8"), filename }),
    ),
    Match.when({ filenameExt: ".txt" }, () =>
      Effect.succeed({ type: "plain-text" as const, text: buffer.toString("utf-8"), filename }),
    ),
    Match.when({ filenameExt: ".pdf", fileTypeExt: "pdf" }, () =>
      getPdfParseResult(buffer, filename),
    ),
    Match.when({ filenameExt: ".docx", fileTypeExt: "docx" }, () =>
      getDocParseResult(buffer, filename),
    ),
    Match.orElse(({ fileTypeExt }) =>
      Effect.fail(new UnsupportedFileTypeError({ filetype: fileTypeExt })),
    ),
  );
});
