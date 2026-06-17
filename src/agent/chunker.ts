import { Match, pipe } from "effect";
import { PDF_PAGES_SEPARATOR } from "./index.js";
import { ParseResult } from "./parsers.js";

type ChunkConfig = {
  chunkSize: number;
  minChunkSize: number;
  overlap: number;
  separators: string[];
};

const MARKDOWN_CONFIG: ChunkConfig = {
  chunkSize: 1800,
  minChunkSize: 100,
  overlap: 200,
  separators: ["\n## ", "\n### ", "\n\n", "\n", ". ", " ", ""],
};

const TEXT_CONFIG: ChunkConfig = {
  chunkSize: 1800,
  minChunkSize: 100,
  overlap: 200,
  separators: ["\n\n", "\n", ". ", " ", ""],
};

export type ChunkResult = {
  content: string;
  charOffset: number;
  pageNumber?: number;
  headingPath?: string[];
};

export function chunkDocument(file: ParseResult, config?: Partial<ChunkConfig>): ChunkResult[] {
  return pipe(
    Match.value(file),
    Match.when({ type: "markdown" }, (input) => {
      const mergedConfig = { ...MARKDOWN_CONFIG, ...config };
      const chunks = splitText(input.text, mergedConfig, MARKDOWN_CONFIG.separators, []);
      const headingIndex = buildHeadingIndex(input.text);

      return pipe(
        chunks,
        //
        addOffsets(input.text, mergedConfig.overlap, { headingIndex }),
      );
    }),
    Match.when({ type: "pdf" }, (input) => {
      const mergedConfig = { ...TEXT_CONFIG, ...config };
      const chunks = splitText(input.pages.join("\n\n"), mergedConfig, TEXT_CONFIG.separators, []);
      const pageBoundaries = buildPageBoundaries(input.pages, PDF_PAGES_SEPARATOR);
      return pipe(
        chunks,
        mergeShortChunks(mergedConfig.minChunkSize),
        addOffsets(input.text, mergedConfig.overlap, { pageBoundaries }),
      );
    }),
    Match.orElse((input) => {
      const mergedConfig = { ...TEXT_CONFIG, ...config };
      const chunks = splitText(input.text, mergedConfig, TEXT_CONFIG.separators, []);

      return pipe(
        chunks,
        mergeShortChunks(mergedConfig.minChunkSize),
        addOffsets(input.text, mergedConfig.overlap),
      );
    }),
  );
}

function buildPageBoundaries(pages: string[], separator: string): number[] {
  return pages.reduce<number[]>((acc, _page, idx) => {
    acc.push(idx === 0 ? 0 : acc[idx - 1] + pages[idx - 1].length + separator.length);
    return acc;
  }, []);
}

type HeadingEntry = {
  offset: number;
  path: string[];
};

function buildHeadingIndex(text: string): HeadingEntry[] {
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  const currentPath: string[] = [];
  return [...text.matchAll(headingRegex)].map((match) => {
    const level = match[1].length;
    const text = match[2];
    const offset = match.index;
    currentPath.length = level - 1;
    currentPath[level - 1] = text;
    return { offset, path: [...currentPath] };
  });
}

function addOffsets(
  originalText: string,
  overlap: number,
  extras?: {
    pageBoundaries?: number[]; // PDF — precomputed before calling
    headingIndex?: { offset: number; path: string[] }[]; // Markdown — precomputed before calling
  },
): (chunks: string[]) => ChunkResult[] {
  return (chunks) => {
    const { results } = chunks.reduce<{ results: ChunkResult[]; searchFrom: number }>(
      (acc, content) => {
        const charOffset = originalText.indexOf(content, acc.searchFrom);
        const pageNumber = extras?.pageBoundaries
          ? extras.pageBoundaries.findLastIndex((b) => b <= charOffset) + 1
          : undefined;

        const headingPath = extras?.headingIndex
          ? extras.headingIndex.findLast((h) => h.offset <= charOffset)?.path
          : undefined;

        const results = acc.results.concat({
          content,
          charOffset,
          pageNumber,
          headingPath,
        });
        const searchFrom = charOffset + content.length - overlap;

        return { results, searchFrom };
      },
      { results: [], searchFrom: 0 },
    );
    return results;
  };
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
    acc.push(text.slice(0, config.chunkSize));
    return splitText(text.slice(config.chunkSize - config.overlap), config, [], acc);
  }

  const parts = text.split(separatorsRemaining[0]);
  const { acc: result, buffer: remaining } = parts
    .filter((p) => p.length > 0)
    .reduce<{ acc: string[]; buffer: string }>(
      ({ acc, buffer }, part) => {
        const candidate = buffer ? buffer + separatorsRemaining[0] + part : part;

        pipe(
          Match.value({
            candidateFits: candidate.length <= config.chunkSize,
            bufferHasContent: buffer.length > 0,
            partTooBig: part.length > config.chunkSize,
          }),
          Match.when({ candidateFits: true }, () => {
            buffer = candidate;
          }),

          Match.when({ candidateFits: false, bufferHasContent: true, partTooBig: true }, () => {
            acc.push(buffer);
            splitText(part, config, separatorsRemaining.slice(1), acc);
            buffer = "";
          }),
          Match.when({ candidateFits: false, bufferHasContent: true, partTooBig: false }, () => {
            acc.push(buffer);
            buffer = part;
          }),
          Match.when({ candidateFits: false, bufferHasContent: false }, () => {
            splitText(part, config, separatorsRemaining.slice(1), acc);
          }),
          // TODO: Add exhaustiveness
        );
        return { acc, buffer };
      },
      { acc, buffer: "" },
    );

  if (remaining.length) {
    result.push(remaining);
  }
  return acc;
}

function mergeShortChunks(minSize: number): (chunks: string[]) => string[] {
  return (chunks) =>
    chunks.reduce<string[]>((acc, chunk) => {
      if (chunk.length < minSize && acc.length > 0) {
        // Merge into the previous chunk
        acc[acc.length - 1] = acc[acc.length - 1] + " " + chunk;
      } else {
        acc.push(chunk);
      }
      return acc;
    }, []);
}
