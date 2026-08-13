import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../test/helpers/diff-helpers";
import type { ResolvedReviewNote } from "../../core/notes/session";
import type { StoredNote } from "../../core/notes/types";
import { buildReviewNoteEntries, resolveReviewNoteJumpTarget } from "./reviewNotes";

function createNotedFile() {
  const before = Array.from({ length: 20 }, (_, index) => `line${index + 1}`);
  const after = [...before.slice(0, 12), "INSERTED", ...before.slice(12)];

  return createTestDiffFile({
    after: lines(...after),
    before: lines(...before),
    context: 100,
    id: "file:noted",
    path: "src/noted.ts",
  });
}

function storedNote(
  overrides: Partial<StoredNote> & Pick<StoredNote, "id" | "filePath">,
): StoredNote {
  return {
    anchorText: "const removed = true;",
    createdAt: "2026-03-22T00:00:00.000Z",
    line: 4,
    side: "new",
    source: "mcp",
    summary: "Stored note",
    ...overrides,
  };
}

describe("buildReviewNoteEntries", () => {
  test("lists placed notes with their line and unplaceable ones with their stored text", () => {
    const file = createNotedFile();
    const withNotes = {
      ...file,
      agent: {
        path: file.path,
        annotations: [
          { id: "placed", summary: "Explain the insert", newRange: [13, 13] as [number, number] },
        ],
      },
    };
    const restored: ResolvedReviewNote[] = [
      {
        note: storedNote({ id: "gone", filePath: file.path, summary: "Line was edited" }),
        state: "unanchored",
        confidence: "high",
      },
    ];

    expect(buildReviewNoteEntries({ file: withNotes, restoredNotes: restored })).toEqual([
      {
        id: "placed",
        fileId: file.id,
        state: "anchored",
        placeable: true,
        source: "ai",
        summary: "Explain the insert",
        location: "R13",
      },
      {
        id: "gone",
        fileId: file.id,
        state: "unanchored",
        placeable: false,
        source: "agent",
        summary: "Line was edited",
        anchorText: "const removed = true;",
      },
    ]);
  });

  test("keeps orphaned notes reachable even though no reviewed file claims them", () => {
    const file = createNotedFile();
    const restored: ResolvedReviewNote[] = [
      {
        note: storedNote({
          id: "orphan",
          filePath: "src/deleted.ts",
          summary: "About a gone file",
        }),
        state: "orphaned",
        confidence: "high",
      },
      {
        note: storedNote({ id: "elsewhere", filePath: "src/other.ts", summary: "Another file" }),
        state: "unanchored",
        confidence: "high",
      },
    ];

    // The orphan's own file left the review, so no per-file list would ever show it; the
    // unanchored note of a different file belongs to that file's list, not this one.
    expect(
      buildReviewNoteEntries({ file, restoredNotes: restored }).map((entry) => entry.id),
    ).toEqual(["orphan"]);
  });

  test("has nothing to list without a selected file", () => {
    expect(buildReviewNoteEntries({ file: undefined, restoredNotes: [] })).toEqual([]);
  });
});

describe("resolveReviewNoteJumpTarget", () => {
  test("resolves a placed note to its own hunk and anchor line", () => {
    const file = createNotedFile();
    const withNotes = {
      ...file,
      agent: {
        path: file.path,
        annotations: [
          { id: "placed", summary: "Explain the insert", newRange: [13, 13] as [number, number] },
        ],
      },
    };

    expect(resolveReviewNoteJumpTarget([withNotes], file.id, "placed")).toEqual({
      hunkIndex: 0,
      lineTarget: { side: "new", line: 13 },
    });
  });

  test("names a note without an id by its position in the file", () => {
    const file = createNotedFile();
    const withNotes = {
      ...file,
      agent: {
        path: file.path,
        annotations: [
          { summary: "First", newRange: [13, 13] as [number, number] },
          { summary: "Second", oldRange: [4, 4] as [number, number] },
        ],
      },
    };

    expect(resolveReviewNoteJumpTarget([withNotes], file.id, `${file.id}#1`)).toEqual({
      hunkIndex: 0,
      lineTarget: { side: "old", line: 4 },
    });
  });

  test("refuses to move the review for a note with no resolved position", () => {
    const file = createNotedFile();
    const withNotes = {
      ...file,
      agent: {
        path: file.path,
        annotations: [
          {
            id: "unanchored",
            summary: "Line is gone",
            newRange: [13, 13] as [number, number],
            restored: {
              state: "unanchored" as const,
              confidence: "high" as const,
              anchorText: "line12",
            },
          },
          { id: "rangeless", summary: "About the whole file" },
        ],
      },
    };

    expect(resolveReviewNoteJumpTarget([withNotes], file.id, "unanchored")).toBeNull();
    expect(resolveReviewNoteJumpTarget([withNotes], file.id, "rangeless")).toBeNull();
    expect(resolveReviewNoteJumpTarget([withNotes], file.id, "missing")).toBeNull();
    expect(resolveReviewNoteJumpTarget([withNotes], "other:file", "unanchored")).toBeNull();
  });
});
