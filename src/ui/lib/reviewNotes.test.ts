import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../test/helpers/diff-helpers";
import type { ResolvedReviewNote } from "../../core/notes/session";
import type { StoredNote } from "../../core/notes/types";
import type { AgentAnnotation, DiffFile } from "../../core/types";
import {
  buildReviewNoteGroups,
  currentReviewNoteId,
  resolveReviewNoteJumpTarget,
} from "./reviewNotes";

function createNotedFile(id = "file:noted", path = "src/noted.ts") {
  const before = Array.from({ length: 20 }, (_, index) => `line${index + 1}`);
  const after = [...before.slice(0, 12), "INSERTED", ...before.slice(12)];

  return createTestDiffFile({
    after: lines(...after),
    before: lines(...before),
    context: 100,
    id,
    path,
  });
}

/** Attach one annotation list to a file, the way a restored review does. */
function withAnnotations(file: DiffFile, annotations: AgentAnnotation[]): DiffFile {
  return { ...file, agent: { path: file.path, annotations } };
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

describe("buildReviewNoteGroups", () => {
  test("lists placed notes with their line and unplaceable ones with their stored text", () => {
    const file = createNotedFile();
    const withNotes = withAnnotations(file, [
      { id: "placed", summary: "Explain the insert", newRange: [13, 13] },
    ]);
    const restored: ResolvedReviewNote[] = [
      {
        note: storedNote({ id: "gone", filePath: file.path, summary: "Line was edited" }),
        state: "unanchored",
        confidence: "high",
      },
    ];

    expect(buildReviewNoteGroups({ files: [withNotes], restoredNotes: restored })).toEqual([
      {
        fileId: file.id,
        label: "src/noted.ts",
        entries: [
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

  test("puts an unanchored note in the group of the file it was stored against", () => {
    const first = createNotedFile("file:first", "src/first.ts");
    const second = createNotedFile("file:second", "src/second.ts");
    const restored: ResolvedReviewNote[] = [
      {
        note: storedNote({ id: "second-stray", filePath: second.path, summary: "Line is gone" }),
        state: "unanchored",
        confidence: "high",
      },
    ];

    expect(
      buildReviewNoteGroups({ files: [first, second], restoredNotes: restored }).map((group) => [
        group.fileId,
        group.entries.map((entry) => entry.id),
      ]),
    ).toEqual([["file:second", ["second-stray"]]]);
  });

  test("keeps orphaned notes reachable under the path they were stored against", () => {
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
    ];

    // The orphan's own file left the review, so it gets a group of its own after the review's
    // files rather than being attached to whichever file happens to be selected.
    expect(
      buildReviewNoteGroups({ files: [file], restoredNotes: restored }).map((group) => [
        group.fileId,
        group.label,
        group.entries.map((entry) => entry.id),
      ]),
    ).toEqual([["", "src/deleted.ts", ["orphan"]]]);
  });

  test("has nothing to list for an empty review", () => {
    expect(buildReviewNoteGroups({ files: [], restoredNotes: [] })).toEqual([]);
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

describe("currentReviewNoteId", () => {
  const file = createNotedFile();
  // Untyped on purpose: `restored` rides structurally on annotations, as the review does it.
  const withNotes = {
    ...file,
    agent: {
      path: file.path,
      annotations: [
        { id: "first", summary: "About the insert", newRange: [13, 13] as [number, number] },
        {
          id: "same-line",
          summary: "Also about the insert",
          newRange: [13, 13] as [number, number],
        },
        { id: "old-side", summary: "About the removed side", oldRange: [4, 4] as [number, number] },
        {
          id: "unplaceable",
          summary: "Line is gone",
          newRange: [18, 18] as [number, number],
          restored: {
            state: "unanchored" as const,
            confidence: "high" as const,
            anchorText: "line17",
          },
        },
      ],
    },
  };
  const cursorOn = (side: "old" | "new", line: number) => ({
    fileId: file.id,
    target: { side, line },
  });

  test("names the note anchored on the current line, on either side", () => {
    expect(currentReviewNoteId([withNotes], cursorOn("new", 13))).toBe("first");
    expect(currentReviewNoteId([withNotes], cursorOn("old", 4))).toBe("old-side");
  });

  test("gives the line to the first note on it, matching where a jump lands the cursor", () => {
    expect(currentReviewNoteId([withNotes], cursorOn("new", 13))).not.toBe("same-line");
  });

  test("names nothing when the current line carries no placeable note", () => {
    expect(currentReviewNoteId([withNotes], null)).toBeNull();
    // A line no note anchors, the other side of an anchored line, an unplaceable note's
    // stored line, and a file outside the review all resolve to no selection.
    expect(currentReviewNoteId([withNotes], cursorOn("new", 14))).toBeNull();
    expect(currentReviewNoteId([withNotes], cursorOn("old", 13))).toBeNull();
    expect(currentReviewNoteId([withNotes], cursorOn("new", 18))).toBeNull();
    expect(
      currentReviewNoteId([withNotes], { fileId: "other:file", target: { side: "new", line: 13 } }),
    ).toBeNull();
    expect(currentReviewNoteId([file], cursorOn("new", 13))).toBeNull();
  });
});
