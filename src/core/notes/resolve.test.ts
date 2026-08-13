import { parseDiffFromFile } from "@pierre/diffs";
import { describe, expect, test } from "bun:test";
import {
  buildEditList,
  captureNoteAnchor,
  type NoteResolutionFile,
  resolveNotes,
  splitLines,
} from "./resolve";
import type { StoredNote } from "./types";

function fileText(...contents: string[]) {
  return `${contents.join("\n")}\n`;
}

const BASE = fileText(
  "export function alpha() {",
  "  const value = 1;",
  "  return value;",
  "}",
  "",
  "export function beta() {",
  "  return 2;",
  "}",
);

const DUPLICATES = fileText(
  "export function alpha() {",
  "  const value = 1;",
  "  return value;",
  "}",
  "export function beta() {",
  "  const value = 2;",
  "  return value;",
  "}",
  "export function gamma() {",
  "  const value = 3;",
  "  return value;",
  "}",
);

/** Build one reviewed file from real Pierre diff data. */
function createTestResolutionFile(before: string, after: string, path = "base.ts") {
  const metadata = parseDiffFromFile(
    { cacheKey: `${path}:before`, contents: before, name: path },
    { cacheKey: `${path}:after`, contents: after, name: path },
    { context: 3 },
    true,
  );

  return { hunks: metadata.hunks, lines: splitLines(after), path } satisfies NoteResolutionFile;
}

/** Build one stored note anchored against the contents it was written over. */
function createTestNote(
  contents: string,
  line: number,
  {
    filePath = "base.ts",
    side = "old",
    withContext = true,
  }: { filePath?: string; side?: StoredNote["side"]; withContext?: boolean } = {},
): StoredNote {
  const anchor = captureNoteAnchor(splitLines(contents), line);

  return {
    anchorText: anchor.anchorText,
    createdAt: "2026-01-01T00:00:00.000Z",
    filePath,
    id: `note-${side}-${line}`,
    line,
    prefixText: withContext ? anchor.prefixText : undefined,
    side,
    source: "mcp",
    suffixText: withContext ? anchor.suffixText : undefined,
    summary: "Check this line",
  };
}

describe("note resolution", () => {
  /** The edit list comes from the diff the review already has, so it must be exact. */
  test("derives one edit per change block from the diff hunks", () => {
    const file = createTestResolutionFile(BASE, fileText("// header", BASE.trimEnd()));

    expect(buildEditList(file.hunks)).toEqual([{ newEnd: 2, newStart: 1, oldEnd: 1, oldStart: 1 }]);
  });

  test("anchors a note when the file has not changed", () => {
    const file = createTestResolutionFile(BASE, BASE);
    const note = createTestNote(BASE, 3);

    expect(resolveNotes([note], [file])).toEqual([
      { confidence: "high", line: 3, note, state: "anchored" },
    ]);
  });

  test("moves a note when lines are inserted above it", () => {
    const after = fileText("// header", BASE.trimEnd());
    const file = createTestResolutionFile(BASE, after);
    const note = createTestNote(BASE, 3);

    expect(resolveNotes([note], [file])).toEqual([
      { confidence: "high", line: 4, note, state: "moved" },
    ]);
  });

  /**
   * The stored context is dropped and the anchor text repeats, so a text search
   * would land on the nearest copy. Only the shift reaches the right line.
   */
  test("shifts a note through the diff rather than guessing among identical lines", () => {
    const after = fileText(
      "export function inserted() {",
      "  const extra = 0;",
      "  return extra;",
      "}",
      "",
      DUPLICATES.trimEnd(),
    );
    const file = createTestResolutionFile(DUPLICATES, after);
    const note = createTestNote(DUPLICATES, 7, { withContext: false });

    expect(resolveNotes([note], [file])).toEqual([
      { confidence: "high", line: 12, note, state: "moved" },
    ]);
  });

  test("keeps a note anchored when the edit is below it", () => {
    const after = BASE.replace("  return 2;", "  return 20;");
    const file = createTestResolutionFile(BASE, after);
    const note = createTestNote(BASE, 3);

    expect(resolveNotes([note], [file])).toEqual([
      { confidence: "high", line: 3, note, state: "anchored" },
    ]);
  });

  test("anchors a note through a reindent of its own line", () => {
    const after = BASE.replace(
      "  const value = 1;\n  return value;",
      "    const value = 1;\n    return value;",
    );
    const file = createTestResolutionFile(BASE, after);
    const note = createTestNote(BASE, 3);

    expect(resolveNotes([note], [file])).toEqual([
      { confidence: "high", line: 3, note, state: "anchored" },
    ]);
  });

  /**
   * The reindent replaces the whole block, so the note has no mapped line and no
   * usable context, and its anchor text repeats inside the block.
   */
  test("keeps a note's offset inside an equal-length replacement", () => {
    const before = fileText(
      "function outer() {",
      "  if (first) {",
      "    return value;",
      "  }",
      "  if (second) {",
      "    return value;",
      "  }",
      "}",
    );
    const after = fileText(
      "function outer() {",
      "    if (first) {",
      "      return value;",
      "    }",
      "    if (second) {",
      "      return value;",
      "    }",
      "}",
    );
    const file = createTestResolutionFile(before, after);
    const note = createTestNote(before, 6, { withContext: false });

    expect(resolveNotes([note], [file])).toEqual([
      { confidence: "high", line: 6, note, state: "anchored" },
    ]);
  });

  test("unanchors a note whose own line was edited", () => {
    const after = BASE.replace("  return value;", "  return value * 2;");
    const file = createTestResolutionFile(BASE, after);
    const note = createTestNote(BASE, 3);

    expect(resolveNotes([note], [file])).toEqual([
      { confidence: "high", note, state: "unanchored" },
    ]);
  });

  test("orphans a note whose file is gone from the review", () => {
    const file = createTestResolutionFile(BASE, BASE);
    const note = createTestNote(BASE, 3, { filePath: "removed.ts" });

    expect(resolveNotes([note], [file])).toEqual([{ confidence: "high", note, state: "orphaned" }]);
  });

  /** A file deleted by the review is still in it, but has no line to point at. */
  test("unanchors a note when the reviewed file has no new side", () => {
    const file = createTestResolutionFile(BASE, "");
    const note = createTestNote(BASE, 3);

    expect(resolveNotes([note], [file])).toEqual([
      { confidence: "high", note, state: "unanchored" },
    ]);
  });

  test("follows a note onto the file's new path after a rename", () => {
    const file = { ...createTestResolutionFile(BASE, BASE, "renamed.ts"), previousPath: "base.ts" };
    const note = createTestNote(BASE, 3);

    expect(resolveNotes([note], [file])).toEqual([
      { confidence: "high", line: 3, note, state: "anchored" },
    ]);
  });

  test("picks the nearest match and lowers confidence when the anchor text repeats", () => {
    const after = fileText("// header", DUPLICATES.trimEnd());
    const file = createTestResolutionFile(DUPLICATES, after);
    const note = createTestNote(DUPLICATES, 7, { side: "new", withContext: false });

    expect(resolveNotes([note], [file])).toEqual([
      { confidence: "low", line: 8, note, state: "moved" },
    ]);
  });

  test("keeps full confidence when stored context singles out one repeated line", () => {
    const after = fileText("// header", DUPLICATES.trimEnd());
    const file = createTestResolutionFile(DUPLICATES, after);
    const note = createTestNote(DUPLICATES, 7, { side: "new" });

    expect(resolveNotes([note], [file])).toEqual([
      { confidence: "high", line: 8, note, state: "moved" },
    ]);
  });
});
