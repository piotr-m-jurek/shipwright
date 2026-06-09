import { fileTypeFromBuffer } from "file-type";
import { extractText, getDocumentProxy } from "unpdf";
import { extractRawText } from "mammoth";
import { UnknownFileExtension, UnknownFileTypeError } from "../shared/errors/index.js";
import path from "node:path";
import { match, P } from "ts-pattern";

export type ParsedFileType = "markdown" | "pdf" | "plain-text" | "docx";

export type ParseResult = (
  | {
      type: Extract<ParsedFileType, "pdf">;
      pages: string[];
    }
  | {
      type: Exclude<ParsedFileType, "pdf">;
    }
) & {
  text: string;
  filename: string;
};

/**
 * @throws UnknownFileTypeError | UnknownFileExtension
 */
export async function parseDocument(buffer: Buffer, filename: string): Promise<ParseResult> {
  const filenameExt = getExtension(filename);
  const fileType = await fileTypeFromBuffer(buffer);

  return match({ filenameExt, fileTypeExt: fileType?.ext })
    .with({ filenameExt: ".md" }, async () => ({
      type: "markdown" as const,
      text: buffer.toString("utf-8"),
      filename,
    }))
    .with({ filenameExt: ".txt" }, async () => ({
      type: "plain-text" as const,
      text: buffer.toString("utf-8"),
      filename,
    }))
    .with({ filenameExt: ".pdf", fileTypeExt: "pdf" }, async () => {
      const raw = await getDocumentProxy(buffer);
      const { text: pages } = await extractText(raw);
      return {
        type: "pdf" as const,
        text: pages.join(PDF_PAGES_SEPARATOR),
        pages,
        filename,
      };
    })
    .with({ filenameExt: P.union(".doc", ".docx"), fileTypeExt: "docx" }, async () => {
      const rawText = await extractRawText({ buffer });
      return { type: "docx" as const, text: rawText.value, filename };
    })
    .otherwise(() => {
      throw new UnknownFileTypeError(
        fileType
          ? "Couldn't determine filetype in parseDocument"
          : "Could not read file type from buffer",
      );
    });
}

/*
 * @throws UnknownFileExtension
 */
function getExtension(filename: string): string {
  try {
    const result = path.extname(filename);
    if (result.length === 0) {
      throw new UnknownFileExtension(`Could not match extension of file: ${filename}`);
    }
    return result;
  } catch (error) {
    throw new UnknownFileExtension(`The filename '${filename}' is not string`, { cause: error });
  }
}
