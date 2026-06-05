import { ParsedFileType } from "./parsers.js";

type ChunkConfig = {
  chunkSize: number;
  overlap: number;
  separators: string[];
};

const MARKDOWN_CONFIG: ChunkConfig = {
  chunkSize: 1800,
  overlap: 200,
  separators: ["\n## ", "\n### ", "\n\n", "\n", ". ", " ", ""],
};

const TEXT_CONFIG: ChunkConfig = {
  chunkSize: 1800,
  overlap: 200,
  separators: ["\n\n", "\n", ". ", " ", ""],
};

export function chunkDocument(
  text: string,
  fileType: ParsedFileType,
  config?: Partial<ChunkConfig>,
): string[] {
  switch (fileType) {
    case "markdown":
      return splitText(text, { ...MARKDOWN_CONFIG, ...config }, MARKDOWN_CONFIG.separators, []);
    case "plain-text":
    case "pdf":
    case "docx":
    default:
      return splitText(text, { ...TEXT_CONFIG, ...config }, TEXT_CONFIG.separators, []);
  }
}

function splitText(
  text: string,
  config: ChunkConfig,
  separatorsRemaining: string[],
  acc: string[],
): string[] {
  if (!text.length) {
    return acc;
  }

  if (text.length <= config.chunkSize) {
    acc.push(text);
    return acc;
  }

  if (!separatorsRemaining.length) {
    const splitted = text.slice(0, config.chunkSize);
    acc.push(splitted);
    return splitText(text.slice(config.chunkSize - config.overlap), config, [], acc);
  }

  const parts = text.split(separatorsRemaining[0]);
  let buffer = "";

  for (const part of parts) {
    if (!part.length) continue;

    const candidate = buffer.length ? buffer + separatorsRemaining[0] + part : part;

    if (candidate.length <= config.chunkSize) {
      // Fits — keep accumulating
      buffer = candidate;
    } else if (buffer.length) {
      // Flush the current buffer as a chunk
      acc.push(buffer);
      // Start new buffer; if the part itself is too big, recurse
      if (part.length > config.chunkSize) {
        splitText(part, config, separatorsRemaining.slice(1), acc);
        buffer = "";
      } else {
        buffer = part;
      }
    } else {
      // buffer is empty but part alone is already too big — recurse
      splitText(part, config, separatorsRemaining.slice(1), acc);
    }
  }

  // Flush remaining buffer
  if (buffer.length) {
    acc.push(buffer);
  }

  return acc;
}
