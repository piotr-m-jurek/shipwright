import { describe, it, expect } from "vitest";
import { diffOutputSections } from "../output-diff";

describe("diffOutputSections (SHIP-182)", () => {
  it("identical versions → all sections unchanged", () => {
    const md = "# Title\n\nsome content\n\n## Scope\n\nmore content\n";
    const result = diffOutputSections(md, md);
    expect(result.every((s) => s.changeType === "unchanged")).toBe(true);
    expect(result.map((s) => s.heading)).toEqual(["Title", "Scope"]);
  });

  it("a section added in the new version is flagged added", () => {
    const oldMd = "# Title\n\ncontent\n";
    const newMd = "# Title\n\ncontent\n\n## New Section\n\nnew stuff\n";
    const result = diffOutputSections(oldMd, newMd);
    const added = result.find((s) => s.heading === "New Section");
    expect(added).toMatchObject({ changeType: "added", oldContent: null, newContent: "new stuff" });
  });

  it("a section removed in the new version is flagged removed", () => {
    const oldMd = "# Title\n\ncontent\n\n## Gone\n\nbye\n";
    const newMd = "# Title\n\ncontent\n";
    const result = diffOutputSections(oldMd, newMd);
    const removed = result.find((s) => s.heading === "Gone");
    expect(removed).toMatchObject({ changeType: "removed", oldContent: "bye", newContent: null });
  });

  it("a section with changed body is flagged modified, both bodies present", () => {
    const oldMd = "# Title\n\nold body\n";
    const newMd = "# Title\n\nnew body\n";
    const result = diffOutputSections(oldMd, newMd);
    expect(result).toEqual([
      { heading: "Title", changeType: "modified", oldContent: "old body", newContent: "new body" },
    ]);
  });

  it("preserves new-version order, appends removed sections after", () => {
    const oldMd = "# A\n\na\n\n## B\n\nb\n";
    const newMd = "## B\n\nb\n\n# C\n\nc\n";
    const result = diffOutputSections(oldMd, newMd);
    expect(result.map((s) => [s.heading, s.changeType])).toEqual([
      ["B", "unchanged"],
      ["C", "added"],
      ["A", "removed"],
    ]);
  });
});
