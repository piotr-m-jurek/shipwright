/**
 * SHIP-182 — deterministic section-level diff between two output versions.
 *
 * No LLM, no external diff library: sections are markdown headers (any
 * level, `#` through `######`), matched between versions by heading text
 * equality. A section present in both versions is `unchanged` (identical
 * body) or `modified` (different body) — the API returns full old/new body
 * text per section rather than a line-level diff; rendering that as a
 * highlighted diff is a frontend concern (SHIP-183), not this function's.
 */

export type OutputDiffSection = {
  heading: string;
  changeType: "added" | "removed" | "modified" | "unchanged";
  oldContent: string | null;
  newContent: string | null;
};

type ParsedSection = { heading: string; content: string };

const HEADING_LINE = /^(#{1,6})\s+(.+)$/;

/**
 * Splits markdown into (heading, body) sections. Content before the first
 * heading (if any) becomes a section with heading "" — every real document
 * this diffs (Brief/PRD) starts with a heading in practice, but this keeps
 * the function total rather than silently dropping a stray preamble.
 */
function parseSections(markdown: string): ParsedSection[] {
  const lines = markdown.split("\n");
  const sections: ParsedSection[] = [];
  let currentHeading = "";
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = HEADING_LINE.exec(line);
    if (match) {
      sections.push({ heading: currentHeading, content: currentLines.join("\n").trim() });
      currentHeading = match[2]!.trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  sections.push({ heading: currentHeading, content: currentLines.join("\n").trim() });

  // Drop a leading empty preamble section (no content before the first
  // heading) — keeping it would surface a spurious "" heading on every diff.
  return sections.filter((s, i) => !(i === 0 && s.heading === "" && s.content === ""));
}

/**
 * Diffs two markdown documents section-by-section. Order: every heading
 * from `newMarkdown`, in its own order (added/modified/unchanged), followed
 * by any heading that existed only in `oldMarkdown` (removed) in ITS
 * original order.
 */
export function diffOutputSections(oldMarkdown: string, newMarkdown: string): OutputDiffSection[] {
  const oldSections = parseSections(oldMarkdown);
  const newSections = parseSections(newMarkdown);

  const oldByHeading = new Map(oldSections.map((s) => [s.heading, s.content]));
  const newHeadings = new Set(newSections.map((s) => s.heading));

  const result: OutputDiffSection[] = newSections.map((section) => {
    const oldContent = oldByHeading.get(section.heading);
    if (oldContent === undefined) {
      return {
        heading: section.heading,
        changeType: "added",
        oldContent: null,
        newContent: section.content,
      };
    }
    return {
      heading: section.heading,
      changeType: oldContent === section.content ? "unchanged" : "modified",
      oldContent,
      newContent: section.content,
    };
  });

  for (const section of oldSections) {
    if (!newHeadings.has(section.heading)) {
      result.push({
        heading: section.heading,
        changeType: "removed",
        oldContent: section.content,
        newContent: null,
      });
    }
  }

  return result;
}
