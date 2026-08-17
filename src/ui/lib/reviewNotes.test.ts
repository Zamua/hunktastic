import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../test/helpers/diff-helpers";
import type { ReviewStoredNote } from "../../core/review/state";
import type { AgentAnnotation, DiffFile } from "../../core/types";
import {
  buildReviewNoteGroups,
  currentReviewNoteId,
  resolveReviewNoteJumpTarget,
} from "./reviewNotes";

function createNotedFile(id = "file:noted", path = "src/noted.ts", context = 100) {
  const before = Array.from({ length: 20 }, (_, index) => `line${index + 1}`);
  const after = [...before.slice(0, 12), "INSERTED", ...before.slice(12)];

  return createTestDiffFile({
    after: lines(...after),
    before: lines(...before),
    context,
    id,
    path,
  });
}

/** Attach one annotation list to a file, the way the merged review stream does. */
function withAnnotations(file: DiffFile, annotations: AgentAnnotation[]): DiffFile {
  return { ...file, agent: { path: file.path, annotations } };
}

/** Build one stored note the way a restore leaves an orphan: quoted, placed nowhere. */
function orphanedStoredNote({
  id,
  filePath,
  summary = "Stored note",
  anchorText = "const removed = true;",
}: {
  id: string;
  filePath: string;
  summary?: string;
  anchorText?: string;
}): ReviewStoredNote {
  return {
    note: {
      id,
      source: "agent",
      fileKey: "",
      anchor: {
        newRange: [4, 4],
        preferred: { side: "new", line: 4 },
        intersectingHunkIndices: [],
      },
      summary,
      createdAt: "2026-03-22T00:00:00.000Z",
      editable: false,
    },
    resolution: "orphaned",
    quote: { filePath, side: "new", line: 4, anchorText },
  };
}

describe("buildReviewNoteGroups", () => {
  test("lists placed notes with their line and orphaned ones with their stored text", () => {
    const file = createNotedFile();
    const withNotes = withAnnotations(file, [
      { id: "placed", summary: "Explain the insert", newRange: [13, 13] },
    ]);
    const stored = [
      orphanedStoredNote({ id: "gone", filePath: "src/deleted.ts", summary: "Line was edited" }),
    ];

    expect(buildReviewNoteGroups({ files: [withNotes], storedNotes: stored })).toEqual([
      {
        fileId: file.id,
        label: "src/noted.ts",
        entries: [
          {
            id: "placed",
            fileId: file.id,
            resolution: "active",
            placeable: true,
            source: "ai",
            summary: "Explain the insert",
            location: "R13",
          },
        ],
      },
      {
        fileId: "",
        label: "src/deleted.ts",
        entries: [
          {
            id: "gone",
            fileId: "",
            resolution: "orphaned",
            placeable: false,
            source: "agent",
            summary: "Line was edited",
            anchorText: "const removed = true;",
          },
        ],
      },
    ]);
  });

  test("covers every file in the review, in review order, under its own heading", () => {
    const first = withAnnotations(createNotedFile("file:first", "src/first.ts"), [
      { id: "first-note", summary: "About the first file", newRange: [13, 13] },
    ]);
    const second = withAnnotations(createNotedFile("file:second", "src/second.ts"), [
      { id: "second-note", summary: "About the second file", newRange: [13, 13] },
    ]);

    const groups = buildReviewNoteGroups({ files: [second, first] });

    expect(groups.map((group) => [group.fileId, group.label])).toEqual([
      ["file:second", "src/second.ts"],
      ["file:first", "src/first.ts"],
    ]);
    // Each entry names its own file, which is what lets a selection cross a file boundary.
    expect(
      groups.flatMap((group) => group.entries.map((entry) => [entry.fileId, entry.id])),
    ).toEqual([
      ["file:second", "second-note"],
      ["file:first", "first-note"],
    ]);
  });

  test("omits a file that carries no notes", () => {
    const bare = createNotedFile("file:bare", "src/bare.ts");
    const noted = withAnnotations(createNotedFile(), [
      { id: "placed", summary: "Explain the insert", newRange: [13, 13] },
    ]);

    expect(buildReviewNoteGroups({ files: [bare, noted] }).map((group) => group.fileId)).toEqual([
      "file:noted",
    ]);
  });

  test("lists a rangeless annotation as an inert row without a location", () => {
    const file = createNotedFile();
    const withNotes = withAnnotations(file, [{ id: "rangeless", summary: "About the whole file" }]);

    expect(buildReviewNoteGroups({ files: [withNotes] })[0]?.entries).toEqual([
      {
        id: "rangeless",
        fileId: file.id,
        resolution: "stale",
        placeable: false,
        source: "ai",
        summary: "About the whole file",
      },
    ]);
  });

  test("keeps orphaned notes reachable under the path they were stored against", () => {
    const file = createNotedFile();
    const stored = [
      orphanedStoredNote({ id: "orphan", filePath: "src/deleted.ts", summary: "Gone file" }),
    ];

    // The orphan's own file left the review, so it gets a group of its own after the review's
    // files rather than being attached to whichever file happens to be selected.
    expect(
      buildReviewNoteGroups({ files: [file], storedNotes: stored }).map((group) => [
        group.fileId,
        group.label,
        group.entries.map((entry) => entry.id),
      ]),
    ).toEqual([["", "src/deleted.ts", ["orphan"]]]);
  });

  test("has nothing to list for an empty review", () => {
    expect(buildReviewNoteGroups({ files: [], storedNotes: [] })).toEqual([]);
  });
});

describe("resolveReviewNoteJumpTarget", () => {
  test("resolves a placed note to its own hunk and anchor line", () => {
    const file = createNotedFile();
    const withNotes = withAnnotations(file, [
      { id: "placed", summary: "Explain the insert", newRange: [13, 13] },
    ]);

    expect(resolveReviewNoteJumpTarget([withNotes], file.id, "placed")).toEqual({
      hunkIndex: 0,
      lineTarget: { side: "new", line: 13 },
    });
  });

  test("names a note without an id by its position in the file", () => {
    const file = createNotedFile();
    const withNotes = withAnnotations(file, [
      { summary: "First", newRange: [13, 13] },
      { summary: "Second", oldRange: [4, 4] },
    ]);

    expect(resolveReviewNoteJumpTarget([withNotes], file.id, `${file.id}#1`)).toEqual({
      hunkIndex: 0,
      lineTarget: { side: "old", line: 4 },
    });
  });

  test("hangs a note outside every hunk from its gap-owner hunk, on its own line", () => {
    // Context 2 keeps the hunk around the inserted line 13, so line 2 sits in the leading gap.
    const file = createNotedFile("file:gapped", "src/gapped.ts", 2);
    const withNotes = withAnnotations(file, [
      { id: "in-gap", summary: "About collapsed context", newRange: [2, 2] },
    ]);

    expect(resolveReviewNoteJumpTarget([withNotes], file.id, "in-gap")).toEqual({
      hunkIndex: 0,
      lineTarget: { side: "new", line: 2 },
    });
  });

  test("refuses to move the review for a note that names no line", () => {
    const file = createNotedFile();
    const withNotes = withAnnotations(file, [{ id: "rangeless", summary: "About the whole file" }]);

    expect(resolveReviewNoteJumpTarget([withNotes], file.id, "rangeless")).toBeNull();
    expect(resolveReviewNoteJumpTarget([withNotes], file.id, "missing")).toBeNull();
    expect(resolveReviewNoteJumpTarget([withNotes], "other:file", "rangeless")).toBeNull();
  });
});

describe("currentReviewNoteId", () => {
  const file = createNotedFile();
  const withNotes = withAnnotations(file, [
    { id: "first", summary: "About the insert", newRange: [13, 13] },
    { id: "same-line", summary: "Also about the insert", newRange: [13, 13] },
    { id: "old-side", summary: "About the removed side", oldRange: [4, 4] },
  ]);
  const cursorOn = (side: "old" | "new", line: number) => ({
    fileId: file.id,
    target: { side, line },
  });

  test("names the note anchored on the current line, on either side", () => {
    expect(currentReviewNoteId([withNotes], cursorOn("new", 13))).toBe("first");
    expect(currentReviewNoteId([withNotes], cursorOn("old", 4))).toBe("old-side");
  });

  test("breaks a shared line by the reveal policy, matching where a jump lands the cursor", () => {
    expect(currentReviewNoteId([withNotes], cursorOn("new", 13))).not.toBe("same-line");
  });

  test("names nothing when the current line carries no anchored note", () => {
    expect(currentReviewNoteId([withNotes], null)).toBeNull();
    // A line no note anchors, the other side of an anchored line, and a file outside the
    // review all resolve to no selection.
    expect(currentReviewNoteId([withNotes], cursorOn("new", 14))).toBeNull();
    expect(currentReviewNoteId([withNotes], cursorOn("old", 13))).toBeNull();
    expect(
      currentReviewNoteId([withNotes], { fileId: "other:file", target: { side: "new", line: 13 } }),
    ).toBeNull();
    expect(currentReviewNoteId([file], cursorOn("new", 13))).toBeNull();
  });
});
