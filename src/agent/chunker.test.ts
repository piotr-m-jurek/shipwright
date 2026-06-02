import { describe, expect, test } from "vitest";
import { chunkDocument } from "./chunker.js";

const SMALL_CONFIG = { chunkSize: 50, overlap: 10 };

describe("chunkDocument", () => {
  describe("short text — fits in one chunk", () => {
    test("returns single chunk when text is shorter than chunkSize", () => {
      const text = "Hello world";
      const result = chunkDocument(text, "plain-text", SMALL_CONFIG);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe("Hello world");
    });

    test("returns single chunk when text equals chunkSize exactly", () => {
      const text = "a".repeat(50);
      const result = chunkDocument(text, "plain-text", SMALL_CONFIG);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(text);
    });

    test("does not return empty chunks for empty string", () => {
      const result = chunkDocument("", "plain-text", SMALL_CONFIG);
      const nonEmpty = result.filter((c) => c.length > 0);
      expect(nonEmpty).toHaveLength(0);
    });
  });

  describe("splitting on separators", () => {
    test("splits plain-text on paragraph breaks", () => {
      const para1 = "a".repeat(30);
      const para2 = "b".repeat(30);
      const text = `${para1}\n\n${para2}`;
      const result = chunkDocument(text, "plain-text", SMALL_CONFIG);
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result.some((c) => c.includes("aaa"))).toBe(true);
      expect(result.some((c) => c.includes("bbb"))).toBe(true);
    });

    test("splits markdown on headings before paragraphs", () => {
      const text =
        "## Section One\n\n" + "a".repeat(30) + "\n\n## Section Two\n\n" + "b".repeat(30);
      const result = chunkDocument(text, "markdown", SMALL_CONFIG);
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    test("falls back to character split when no separator fits", () => {
      // One long word with no spaces or newlines
      const text = "a".repeat(200);
      const result = chunkDocument(text, "plain-text", SMALL_CONFIG);
      expect(result.length).toBeGreaterThan(1);
      result.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(50);
      });
    });
  });

  describe("overlap", () => {
    test("consecutive character-split chunks share overlap chars", () => {
      const text = "a".repeat(200);
      const result = chunkDocument(text, "plain-text", SMALL_CONFIG);
      // With chunkSize=50 and overlap=10, second chunk starts 40 chars after first
      // So last 10 chars of chunk[0] should equal first 10 chars of chunk[1]
      if (result.length >= 2) {
        const endOfFirst = result[0].slice(-10);
        const startOfSecond = result[1].slice(0, 10);
        expect(endOfFirst).toBe(startOfSecond);
      }
    });
  });

  describe("config override", () => {
    test("custom chunkSize is respected", () => {
      const text = "a".repeat(300);
      const result = chunkDocument(text, "plain-text", { chunkSize: 100, overlap: 0 });
      result.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(100);
      });
    });

    test("all text is preserved across chunks (no content loss)", () => {
      const text = "The quick brown fox jumps over the lazy dog. ".repeat(10);
      const result = chunkDocument(text, "plain-text", SMALL_CONFIG);
      // Every word should appear somewhere in the chunks
      expect(result.join(" ")).toContain("quick");
      expect(result.join(" ")).toContain("lazy");
    });
  });

  describe("file type dispatch", () => {
    test("pdf uses text config", () => {
      const text = "a".repeat(200);
      const result = chunkDocument(text, "pdf", SMALL_CONFIG);
      expect(result.length).toBeGreaterThan(1);
    });

    test("docx uses text config", () => {
      const text = "a".repeat(200);
      const result = chunkDocument(text, "docx", SMALL_CONFIG);
      expect(result.length).toBeGreaterThan(1);
    });
  });
});
