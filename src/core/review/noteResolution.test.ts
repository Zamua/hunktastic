import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../test/helpers/diff-helpers";
import type { DiffFile } from "../types";
import type { DiffSide, StoredNote } from "../notes/types";
import { projectReviewDocument } from "./document";
import {
  captureReviewNoteQuote,
  resolveReviewNoteQuotes,
  reviewNoteCorpus,
  reviewNoteQuoteForStoredNote,
  reviewNoteResolutionFromState,
  reviewNoteSourceFromStoredLabel,
} from "./noteResolution";
import type { ReviewNoteQuote } from "./state";
import type { ReviewFileV1 } from "./types";

const BASE_LINES = Array.from(
  { length: 30 },
  (_, index) => `const line${index + 1} = ${index + 1};`,
);

/** Build the 30-line fixture with one line replaced, so exactly one hunk exists. */
function changedAt(line: number, value: string) {
  const after = [...BASE_LINES];
  after[line - 1] = value;
  return after;
}

function fixtureDiffFile(after: string[], path = "example.ts"): DiffFile {
  return createTestDiffFile({
    after: lines(...after),
    before: lines(...BASE_LINES),
    context: 3,
    id: path,
    path,
  });
}

function fixtureFile(after: string[], path = "example.ts"): ReviewFileV1 {
  return projectReviewDocument([fixtureDiffFile(after, path)]).files[0]!;
}

/** Flip one projected file to partial, dropping its whole-file line attestation. */
function asPartial(file: ReviewFileV1): ReviewFileV1 {
  return { ...file, flags: { ...file.flags, partial: true } };
}

/** Author one quote the way the store does, against the file it was written over. */
function quoteAt(file: ReviewFileV1, side: DiffSide, line: number): ReviewNoteQuote {
  return captureReviewNoteQuote(file, side, line);
}

describe("reviewNoteResolutionFromState", () => {
  test("maps the ladder onto the stored-note vocabulary", () => {
    expect(reviewNoteResolutionFromState("anchored")).toBe("active");
    expect(reviewNoteResolutionFromState("moved")).toBe("active");
    expect(reviewNoteResolutionFromState("unanchored")).toBe("stale");
    expect(reviewNoteResolutionFromState("orphaned")).toBe("orphaned");
  });
});

describe("reviewNoteSourceFromStoredLabel", () => {
  test("normalizes persisted labels once, at the restore boundary", () => {
    expect(reviewNoteSourceFromStoredLabel("user")).toBe("user");
    expect(reviewNoteSourceFromStoredLabel("mcp")).toBe("agent");
    expect(reviewNoteSourceFromStoredLabel("agent")).toBe("agent");
    expect(reviewNoteSourceFromStoredLabel("sidecar")).toBe("ai");
  });
});

describe("reviewNoteCorpus", () => {
  test("a complete diff attests every line of the file, gaps included", () => {
    const file = fixtureFile(changedAt(10, "const line10 = 100;"));
    const corpus = reviewNoteCorpus(file, "new");

    expect(corpus[9]).toBe("const line10 = 100;");
    // Line 3 sits in the collapsed gap before the hunk; the complete side array carries it.
    expect(corpus[2]).toBe("const line3 = 3;");
    expect(corpus[29]).toBe("const line30 = 30;");
    expect(reviewNoteCorpus(file, "old")[9]).toBe("const line10 = 10;");
  });

  test("a partial diff leaves gap lines empty until source text fills them", () => {
    const file = asPartial(fixtureFile(changedAt(10, "const line10 = 100;")));

    const bare = reviewNoteCorpus(file, "new");
    expect(bare[9]).toBe("const line10 = 100;");
    expect(bare[2]).toBeUndefined();

    const filled = reviewNoteCorpus(file, "new", lines(...changedAt(10, "const line10 = 100;")));
    expect(filled[2]).toBe("const line3 = 3;");
    // The old side reads the same gap rows through the expansion side's text.
    expect(reviewNoteCorpus(file, "old", lines(...changedAt(10, "const line10 = 100;")))[2]).toBe(
      "const line3 = 3;",
    );
  });
});

describe("captureReviewNoteQuote", () => {
  test("quotes three lines on each side of the anchor", () => {
    const file = fixtureFile(changedAt(10, "const line10 = 100;"));

    expect(captureReviewNoteQuote(file, "new", 10)).toEqual({
      filePath: "example.ts",
      side: "new",
      line: 10,
      anchorText: "const line10 = 100;",
      prefixText: "const line7 = 7;\nconst line8 = 8;\nconst line9 = 9;",
      suffixText: "const line11 = 11;\nconst line12 = 12;\nconst line13 = 13;",
    });
  });

  test("stops the quote where the review stops attesting lines", () => {
    // Partial and without source text, the corpus carries only the hunk's rows (7..13).
    const file = asPartial(fixtureFile(changedAt(10, "const line10 = 100;")));

    expect(captureReviewNoteQuote(file, "new", 7)).toEqual({
      filePath: "example.ts",
      side: "new",
      line: 7,
      anchorText: "const line7 = 7;",
      prefixText: "",
      suffixText: "const line8 = 8;\nconst line9 = 9;\nconst line10 = 100;",
    });
  });

  test("a note authored on an expanded gap line quotes the loaded source, not a blank", () => {
    const file = asPartial(fixtureFile(changedAt(10, "const line10 = 100;")));
    const sourceText = lines(...changedAt(10, "const line10 = 100;"));

    // Without the source the gap line has no text at all (the old unrecoverable case).
    expect(captureReviewNoteQuote(file, "new", 3).anchorText).toBe("");

    expect(captureReviewNoteQuote(file, "new", 3, sourceText)).toEqual({
      filePath: "example.ts",
      side: "new",
      line: 3,
      anchorText: "const line3 = 3;",
      prefixText: "const line1 = 1;\nconst line2 = 2;",
      suffixText: "const line4 = 4;\nconst line5 = 5;\nconst line6 = 6;",
    });
  });
});

describe("resolveReviewNoteQuotes", () => {
  test("an unchanged review anchors the note at its own line", () => {
    const file = fixtureFile(changedAt(10, "const line10 = 100;"));
    const quote = quoteAt(file, "new", 10);

    expect(resolveReviewNoteQuotes([quote], [file])).toEqual([
      {
        resolution: "active",
        confidence: "high",
        fileKey: file.key,
        placement: {
          hunkIndex: 0,
          side: "new",
          line: 10,
          anchor: {
            newRange: [10, 10],
            preferred: { side: "new", line: 10 },
            intersectingHunkIndices: [0],
            ownerHunkIndex: 0,
          },
        },
      },
    ]);
  });

  test("an edit above the note moves it to where its text now sits", () => {
    const authored = fixtureFile(changedAt(10, "const line10 = 100;"));
    const quote = quoteAt(authored, "new", 10);
    const shifted = fixtureFile([
      "const inserted1 = 1;",
      "const inserted2 = 2;",
      ...changedAt(10, "const line10 = 100;"),
    ]);

    const [resolved] = resolveReviewNoteQuotes([quote], [shifted]);

    expect(resolved?.resolution).toBe("active");
    expect(resolved?.placement?.line).toBe(12);
  });

  test("a reindent of the anchored line keeps the note active", () => {
    const authored = fixtureFile(changedAt(10, "const line10 = 100;"));
    const quote = quoteAt(authored, "new", 10);
    const reindented = fixtureFile(changedAt(10, "    const line10 = 100;"));

    const [resolved] = resolveReviewNoteQuotes([quote], [reindented]);

    expect(resolved?.resolution).toBe("active");
    expect(resolved?.placement?.line).toBe(10);
  });

  test("an edit to the anchored line itself degrades the note but keeps its stored placement", () => {
    const authored = fixtureFile(changedAt(10, "const line10 = 100;"));
    const quote = quoteAt(authored, "new", 10);
    const edited = fixtureFile(changedAt(10, "const line10 = 999;"));

    expect(resolveReviewNoteQuotes([quote], [edited])).toEqual([
      {
        resolution: "stale",
        confidence: "high",
        fileKey: edited.key,
        placement: {
          hunkIndex: 0,
          side: "new",
          line: 10,
          anchor: {
            newRange: [10, 10],
            preferred: { side: "new", line: 10 },
            intersectingHunkIndices: [0],
            ownerHunkIndex: 0,
          },
        },
      },
    ]);
  });

  test("a quote of vanished text stays placed at its coordinates, hung from the gap owner", () => {
    const file = fixtureFile(changedAt(10, "const line10 = 100;"));
    const quote: ReviewNoteQuote = {
      filePath: file.path,
      side: "new",
      line: 25,
      anchorText: "const vanished = 0;",
    };

    expect(resolveReviewNoteQuotes([quote], [file])).toEqual([
      {
        resolution: "stale",
        confidence: "high",
        fileKey: file.key,
        placement: {
          hunkIndex: 0,
          side: "new",
          line: 25,
          anchor: {
            newRange: [25, 25],
            preferred: { side: "new", line: 25 },
            intersectingHunkIndices: [],
            ownerHunkIndex: 0,
          },
        },
      },
    ]);
  });

  test("a file missing from the review orphans its notes", () => {
    const authored = fixtureFile(changedAt(10, "const line10 = 100;"));
    const quote = quoteAt(authored, "new", 10);

    expect(
      resolveReviewNoteQuotes(
        [quote],
        [fixtureFile(changedAt(10, "const line10 = 100;"), "other.ts")],
      ),
    ).toEqual([{ resolution: "orphaned", confidence: "high" }]);
  });

  test("a renamed file still carries the notes taken against its old path", () => {
    const authored = fixtureFile(changedAt(10, "const line10 = 100;"));
    const quote = quoteAt(authored, "new", 10);
    const renamed = projectReviewDocument([
      createTestDiffFile({
        after: lines(...changedAt(10, "const line10 = 100;")),
        before: lines(...BASE_LINES),
        context: 3,
        id: "renamed",
        path: "renamed.ts",
        previousPath: "example.ts",
      }),
    ]).files[0]!;

    const [resolved] = resolveReviewNoteQuotes([quote], [renamed]);

    expect(resolved?.fileKey).toBe(renamed.key);
    expect(resolved?.resolution).toBe("active");
  });

  test("a note on a deleted line comes back on the side that still shows it", () => {
    const deleted = fixtureFile(BASE_LINES.filter((_, index) => index !== 9));
    const quote = quoteAt(deleted, "old", 10);

    const [resolved] = resolveReviewNoteQuotes([quote], [deleted]);

    expect(resolved?.resolution).toBe("active");
    expect(resolved?.placement).toEqual({
      hunkIndex: 0,
      side: "old",
      line: 10,
      anchor: {
        oldRange: [10, 10],
        preferred: { side: "old", line: 10 },
        intersectingHunkIndices: [0],
        ownerHunkIndex: 0,
      },
    });
  });

  test("duplicate anchor text picks the nearest match and reports low confidence", () => {
    const duplicated = [...BASE_LINES];
    duplicated[9] = "const duplicate = 0;";
    duplicated[20] = "const duplicate = 0;";
    const file = fixtureFile(duplicated);
    // Stored one line off its text, with the anchor alone quoted, so both copies
    // stay candidates once the text at the shifted line fails to confirm.
    const quote: ReviewNoteQuote = {
      filePath: file.path,
      side: "new",
      line: 11,
      anchorText: "const duplicate = 0;",
    };

    const [resolved] = resolveReviewNoteQuotes([quote], [file]);

    expect(resolved?.confidence).toBe("low");
    expect(resolved?.placement?.line).toBe(10);
  });

  test("carries a persisted record's quote fields without its identity fields", () => {
    const record: StoredNote = {
      id: "mcp:1",
      filePath: "example.ts",
      side: "new",
      line: 10,
      summary: "Check this",
      source: "mcp",
      createdAt: "2026-01-01T00:00:00.000Z",
      anchorText: "const line10 = 100;",
      prefixText: "const line9 = 9;",
    };

    expect(reviewNoteQuoteForStoredNote(record)).toEqual({
      filePath: "example.ts",
      side: "new",
      line: 10,
      anchorText: "const line10 = 100;",
      prefixText: "const line9 = 9;",
    });
  });
});
