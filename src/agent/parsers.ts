import { fileTypeFromBuffer } from "file-type";
import { extractText, getDocumentProxy } from "unpdf";
import { extractRawText } from "mammoth";
import { UnknownFileExtension, UnknownFileTypeError } from "../shared/errors/index.js";
import path from "node:path";

export type ParsedFileType = "markdown" | "pdf" | "plain-text" | "docx";

export type ParseResult = {
  type: ParsedFileType;
  text: string;
  filename: string;
};

/**
 * @throws UnknownFileTypeError | UnknownFileExtension
 */
export async function parseDocument(buffer: Buffer, filename: string): Promise<ParseResult> {
  const filenameExt = getExtension(filename);
  const fileType = await fileTypeFromBuffer(buffer);

  if (filenameExt === ".md") {
    return { type: "markdown", text: buffer.toString("utf-8"), filename };
  }

  if (filenameExt === ".txt") {
    return { type: "plain-text", text: buffer.toString("utf-8"), filename };
  }

  if (!fileType) {
    throw new UnknownFileTypeError("Could not read file type from buffer");
  }

  if (filenameExt === ".pdf" && fileType.ext === "pdf") {
    const raw = await getDocumentProxy(buffer);
    const { text } = await extractText(raw);
    return { type: "pdf", text: text.join("\n\n"), filename };
  }

  if ((filenameExt === ".doc" || filenameExt === ".docx") && fileType.ext === "docx") {
    const rawText = await extractRawText({ buffer: buffer });
    return {
      type: "docx",
      text: rawText.value,
      filename,
    };
  }
  throw new UnknownFileTypeError("Couldn't determine filetype in parseDocument");
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
