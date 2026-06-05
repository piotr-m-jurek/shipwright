import { ParsedFileType } from "./parsers.js";
import { match, P } from "ts-pattern";

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
  return match(fileType)
    .with("markdown", () =>
      splitText(text, { ...MARKDOWN_CONFIG, ...config }, MARKDOWN_CONFIG.separators, []),
    )
    .otherwise(() => splitText(text, { ...TEXT_CONFIG, ...config }, TEXT_CONFIG.separators, []));
}

function splitText(
  text: string,
  config: ChunkConfig,
  separatorsRemaining: string[],
  acc: string[],
): string[] {
  if (!text.length) return acc;
  if (text.length <= config.chunkSize) {
    acc.push(text);
    return acc;
  }
  if (!separatorsRemaining.length) {
    acc.push(text.slice(0, config.chunkSize));
    return splitText(text.slice(config.chunkSize - config.overlap), config, [], acc);
  }

  const parts = text.split(separatorsRemaining[0]);
  let buffer = "";

  for (const part of parts) {
    if (!part.length) continue;

    const candidate = buffer ? buffer + separatorsRemaining[0] + part : part;

    match({
      candidateFits: candidate.length <= config.chunkSize,
      bufferHasContent: buffer.length > 0,
      partTooBig: part.length > config.chunkSize,
    })
      .with({ candidateFits: true }, () => {
        buffer = candidate;
      })
      .with({ candidateFits: false, bufferHasContent: true, partTooBig: true }, () => {
        acc.push(buffer);
        splitText(part, config, separatorsRemaining.slice(1), acc);
        buffer = "";
      })
      .with({ candidateFits: false, bufferHasContent: true, partTooBig: false }, () => {
        acc.push(buffer);
        buffer = part;
      })
      .with({ candidateFits: false, bufferHasContent: false }, () => {
        splitText(part, config, separatorsRemaining.slice(1), acc);
      })
      .exhaustive();
  }

  if (buffer.length) acc.push(buffer);

  return acc;
}
