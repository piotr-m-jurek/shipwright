import { fileTypeFromBuffer } from "file-type";
import { extractText, getDocumentProxy } from "unpdf";
import { extractRawText } from "mammoth";

export type ParsedFileType = "markdown" | "pdf" | "plain-text" | "docx";
export type ParseResult = {
  type: ParsedFileType;
  text: string;
  filename: string;
};

export class UnknownFileTypeError extends Error {}
export class UnknownFileExtension extends Error {}

/**
 * @throws UnknownFileTypeError | UnknownFileExtension
 */
export async function parseDocument(buffer: Buffer, filename: string): Promise<ParseResult> {
  const filenameExt = getExtension(filename);

  if (filenameExt === ".md") {
    return { type: "markdown", text: buffer.toString("utf-8"), filename };
  }

  if (filenameExt === ".txt") {
    return { type: "plain-text", text: buffer.toString("utf-8"), filename };
  }

  const fileType = await fileTypeFromBuffer(buffer);
  if (!fileType) {
    throw new UnknownFileTypeError("Could not read file type from buffer");
  }

  if (filenameExt === ".pdf" && fileType.ext === "pdf") {
    const raw = await getDocumentProxy(buffer);
    const { text } = await extractText(raw);
    return { type: "pdf", text: text.join("\n"), filename };
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

/**
 * @throws UnknownFileExtension
 */
function getExtension(filename: string): string {
  const extensionMatch = filename.match(/\.(\w+)$/);
  if (!extensionMatch || !extensionMatch.length) {
    throw new UnknownFileExtension();
  }

  return extensionMatch[0];
}
