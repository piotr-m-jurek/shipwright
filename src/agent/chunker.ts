import { getEncoding } from "js-tiktoken";
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

  if (text.length < config.chunkSize) {
    acc.push(text);
    return acc;
  }

  if (!separatorsRemaining.length) {
    const splitted = text.slice(0, config.chunkSize);
    acc.push(splitted);
    return splitText(text.slice(config.chunkSize - config.overlap), config, [], acc);
  }

  const splitted = text.split(separatorsRemaining[0]);
  splitted.forEach((part) => {
    if (part.length > config.chunkSize) {
      const parts = splitText(part, config, separatorsRemaining.slice(1), acc);
      acc.push(...parts);
    } else {
      acc.push(part);
    }
  });

  return acc;
}

export function estimateTokenCount(text: string): number {
  const encoding = getEncoding("cl100k_base");
  return encoding.encode(text).length;
}
