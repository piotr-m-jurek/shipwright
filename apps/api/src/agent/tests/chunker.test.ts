import { describe, expect, test } from "vitest";
import { chunkDocument, type ChunkResult } from "../chunker.js";

// minChunkSize: 0 disables the merge guard — tests that explicitly test merging
// set their own minChunkSize via the config override.
const SMALL_CONFIG = { chunkSize: 50, overlap: 10, minChunkSize: 0 };

// Helper to extract content strings from ChunkResult[]
const contents = (chunks: ChunkResult[]) => chunks.map((c) => c.content);

describe("chunkDocument", () => {
  describe("short text — fits in one chunk", () => {
    test("returns single chunk when text is shorter than chunkSize", () => {
      const text = "Hello world";
      const result = chunkDocument({ text, type: "plain-text", filename: "" }, SMALL_CONFIG);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("Hello world");
    });

    test("returns single chunk when text equals chunkSize exactly", () => {
      const text = "a".repeat(50);
      const result = chunkDocument({ text, type: "plain-text", filename: "" }, SMALL_CONFIG);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe(text);
    });

    test("does not return empty chunks for empty string", () => {
      const result = chunkDocument({ text: "", type: "plain-text", filename: "" }, SMALL_CONFIG);
      const nonEmpty = result.filter((c) => c.content.length > 0);
      expect(nonEmpty).toHaveLength(0);
    });
  });

  describe("splitting on separators", () => {
    test("splits plain-text on paragraph breaks", () => {
      const para1 = "a".repeat(30);
      const para2 = "b".repeat(30);
      const text = `${para1}\n\n${para2}`;
      const result = chunkDocument({ text, type: "plain-text", filename: "" }, SMALL_CONFIG);
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(contents(result).some((c) => c.includes("aaa"))).toBe(true);
      expect(contents(result).some((c) => c.includes("bbb"))).toBe(true);
    });

    test("splits markdown on headings before paragraphs", () => {
      const text =
        "## Section One\n\n" + "a".repeat(30) + "\n\n## Section Two\n\n" + "b".repeat(30);
      const result = chunkDocument({ text, type: "markdown", filename: "" }, SMALL_CONFIG);
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    test("falls back to character split when no separator fits", () => {
      const text = "a".repeat(200);
      const result = chunkDocument({ text: text, type: "plain-text", filename: "" }, SMALL_CONFIG);
      expect(result.length).toBeGreaterThan(1);
      result.forEach((chunk) => {
        expect(chunk.content.length).toBeLessThanOrEqual(50);
      });
    });
  });

  describe("overlap", () => {
    test("consecutive character-split chunks share overlap chars", () => {
      const text = "a".repeat(200);
      const result = chunkDocument({ text: text, type: "plain-text", filename: "" }, SMALL_CONFIG);
      if (result.length >= 2) {
        const endOfFirst = result[0].content.slice(-10);
        const startOfSecond = result[1].content.slice(0, 10);
        expect(endOfFirst).toBe(startOfSecond);
      }
    });
  });

  describe("config override", () => {
    test("custom chunkSize is respected", () => {
      const text = "a".repeat(300);
      const result = chunkDocument(
        { text: text, type: "plain-text", filename: "" },
        { chunkSize: 100, overlap: 0 },
      );
      result.forEach((chunk) => {
        expect(chunk.content.length).toBeLessThanOrEqual(100);
      });
    });

    test("all text is preserved across chunks (no content loss)", () => {
      const text = "The quick brown fox jumps over the lazy dog. ".repeat(10);
      const result = chunkDocument({ text: text, type: "plain-text", filename: "" }, SMALL_CONFIG);
      expect(contents(result).join(" ")).toContain("quick");
      expect(contents(result).join(" ")).toContain("lazy");
    });
  });

  describe("location metadata", () => {
    test("every chunk has a charOffset", () => {
      const text = "a".repeat(200);
      const result = chunkDocument({ text: text, type: "plain-text", filename: "" }, SMALL_CONFIG);
      result.forEach((chunk) => {
        expect(typeof chunk.charOffset).toBe("number");
        expect(chunk.charOffset).toBeGreaterThanOrEqual(0);
      });
    });

    test("charOffset increases monotonically", () => {
      const text = "a".repeat(200);
      const result = chunkDocument({ text: text, type: "plain-text", filename: "" }, SMALL_CONFIG);
      for (let i = 1; i < result.length; i++) {
        expect(result[i].charOffset).toBeGreaterThan(result[i - 1].charOffset);
      }
    });

    test("first chunk has charOffset of 0", () => {
      const text = "Hello world this is a test";
      const result = chunkDocument({ text: text, type: "plain-text", filename: "" }, SMALL_CONFIG);
      expect(result[0].charOffset).toBe(0);
    });

    test("pageNumber is undefined for plain-text chunks", () => {
      const text = "a".repeat(200);
      const result = chunkDocument({ text: text, type: "plain-text", filename: "" }, SMALL_CONFIG);
      result.forEach((chunk) => {
        expect(chunk.pageNumber).toBeUndefined();
      });
    });

    test("headingPath is undefined for plain-text chunks", () => {
      const text = "a".repeat(200);
      const result = chunkDocument({ text: text, type: "plain-text", filename: "" }, SMALL_CONFIG);
      result.forEach((chunk) => {
        expect(chunk.headingPath).toBeUndefined();
      });
    });

    test("headingPath is set for markdown chunks under a heading", () => {
      const text =
        "## Introduction\n\n" + "a".repeat(30) + "\n\n## Conclusion\n\n" + "b".repeat(30);
      const result = chunkDocument({ text: text, type: "markdown", filename: "" }, SMALL_CONFIG);
      const chunksWithHeadings = result.filter((c) => c.headingPath !== undefined);
      expect(chunksWithHeadings.length).toBeGreaterThan(0);
    });
  });

  describe("small parts merging — window filling", () => {
    test("small parts are merged to fill the window, not emitted individually (Bug A)", () => {
      const text = Array(6).fill("a".repeat(20)).join("\n\n");
      const result = chunkDocument(
        { text: text, type: "plain-text", filename: "" },
        { chunkSize: 100, overlap: 10, minChunkSize: 0 },
      );
      expect(result.length).toBe(2);
      result.forEach((chunk) => expect(chunk.content.length).toBeLessThanOrEqual(100));
      expect(contents(result).join("\n\n")).toBe(text);
    });

    test("merged chunk content exactly equals the joined parts (Bug A — content check)", () => {
      const parts = ["a".repeat(30), "b".repeat(30), "c".repeat(30), "d".repeat(30)];
      const text = parts.join("\n\n");
      const result = chunkDocument(
        { text: text, type: "plain-text", filename: "" },
        { chunkSize: 80, overlap: 10, minChunkSize: 0 },
      );
      expect(result.length).toBe(2);
      expect(result[0].content).toBe(parts[0] + "\n\n" + parts[1]);
      expect(result[1].content).toBe(parts[2] + "\n\n" + parts[3]);
    });

    test("no chunk is duplicated — double-push regression (Bug B)", () => {
      const para1 = "a".repeat(120);
      const para2 = "b".repeat(120);
      const text = `${para1}\n\n${para2}`;
      const result = chunkDocument(
        { text: text, type: "plain-text", filename: "" },
        { chunkSize: 100, overlap: 10 },
      );
      const unique = new Set(contents(result));
      expect(unique.size).toBe(result.length);
    });

    test("chunk count from recursive branch is not doubled (Bug B — count check)", () => {
      const para1 = "a".repeat(120);
      const para2 = "b".repeat(120);
      const text = `${para1}\n\n${para2}`;
      const result = chunkDocument(
        { text: text, type: "plain-text", filename: "" },
        { chunkSize: 100, overlap: 10, minChunkSize: 0 },
      );
      expect(result.length).toBe(4);
    });
  });

  describe("minimum chunk size guard — mergeShortChunks", () => {
    test("short chunk below minChunkSize is merged into the previous chunk", () => {
      // Two paragraphs: one long, one short (below default 100-char min)
      const longPara = "a".repeat(60);
      const shortPara = "tiny";
      const text = `${longPara}\n\n${shortPara}`;
      const result = chunkDocument(
        { text, type: "plain-text", filename: "" },
        { chunkSize: 80, overlap: 0, minChunkSize: 10 },
      );
      // "tiny" is 4 chars, below minChunkSize:10 — should be merged into previous
      expect(result.length).toBe(1);
      expect(result[0].content).toContain("tiny");
      expect(result[0].content).toContain("aaa");
    });

    test("short first chunk with no previous is kept as-is", () => {
      // When the very first chunk is short there's nothing to merge into
      const text = "hi";
      const result = chunkDocument(
        { text, type: "plain-text", filename: "" },
        { chunkSize: 80, overlap: 0, minChunkSize: 10 },
      );
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("hi");
    });

    test("chunks at or above minChunkSize are not merged", () => {
      const para1 = "a".repeat(50);
      const para2 = "b".repeat(50);
      const text = `${para1}\n\n${para2}`;
      const result = chunkDocument(
        { text, type: "plain-text", filename: "" },
        { chunkSize: 80, overlap: 0, minChunkSize: 10 },
      );
      // Both paragraphs are 50 chars — above minChunkSize:10 — not merged
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    test("multiple consecutive short chunks are all merged into the preceding long chunk", () => {
      const longPara = "a".repeat(60);
      // Three short paragraphs below minChunkSize
      const text = `${longPara}\n\nhi\n\nyo\n\nok`;
      const result = chunkDocument(
        { text, type: "plain-text", filename: "" },
        { chunkSize: 80, overlap: 0, minChunkSize: 10 },
      );
      // All three short chunks merge into the long paragraph's chunk
      const joined = contents(result).join(" ");
      expect(joined).toContain("hi");
      expect(joined).toContain("yo");
      expect(joined).toContain("ok");
      expect(result.length).toBe(1);
    });

    test("pdf chunks are also subject to the minimum size guard", () => {
      const longPage = "a".repeat(60);
      const shortPage = "tiny";
      const result = chunkDocument(
        {
          type: "pdf",
          pages: [longPage, shortPage],
          text: `${longPage}\n\n${shortPage}`,
          filename: "",
        },
        { chunkSize: 80, overlap: 0, minChunkSize: 10 },
      );
      const joined = contents(result).join(" ");
      expect(joined).toContain("tiny");
      // "tiny" should be merged, not a standalone chunk
      expect(result.every((c) => c.content.length >= 10 || result.length === 1)).toBe(true);
    });
  });

  describe("file type dispatch", () => {
    test("pdf uses text config", () => {
      const pages = ["a".repeat(100), "a".repeat(100)];
      const result = chunkDocument(
        { type: "pdf", pages, text: pages.join("\n\n"), filename: "" },
        SMALL_CONFIG,
      );
      expect(result.length).toBeGreaterThan(1);
    });

    test("docx uses text config", () => {
      const text = "a".repeat(200);
      const result = chunkDocument({ text: text, type: "docx", filename: "" }, SMALL_CONFIG);
      expect(result.length).toBeGreaterThan(1);
    });
  });
});
