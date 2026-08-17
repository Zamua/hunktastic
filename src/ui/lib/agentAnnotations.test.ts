import { describe, expect, test } from "bun:test";
import { reviewAnnotatedHunkIndices } from "../../core/review/annotations";
import { resolveReviewRevealNoteId } from "../../core/review/selectors";
import { reviewNoteAnchorLine } from "../../core/review/state";
import { createTestDiffFile, lines } from "../../../test/helpers/diff-helpers";
import { buildLiveComment, resolveCommentTarget } from "../../core/liveComments";
import type { DiffFile } from "../../core/types";
import {
  annotatedHunkLineTarget,
  annotationRangeLabel,
  getSelectedAnnotations,
  resolveVisibleReviewNotes,
} from "./agentAnnotations";

function createContextHeavyHunkFile() {
  const beforeLines = Array.from({ length: 25 }, (_, i) => `line${i + 1}`);
  const afterLines = [...beforeLines.slice(0, 12), "INSERTED", ...beforeLines.slice(12)];

  return createTestDiffFile({
    before: lines(...beforeLines),
    after: lines(...afterLines),
    context: 100,
    id: "file:context-heavy-annotation",
    path: "src/sparse.ts",
    previousPath: "src/sparse.ts",
  });
}

describe("agent annotations", () => {
  test("formats inline note locations with GitHub-style file and side anchors", () => {
    const file = createContextHeavyHunkFile();

    expect(annotationRangeLabel({ summary: "Added", newRange: [142, 142] }, file)).toBe(
      "src/sparse.ts R142",
    );
    expect(annotationRangeLabel({ summary: "Removed", oldRange: [88, 91] }, file)).toBe(
      "src/sparse.ts L88–L91",
    );
    expect(
      annotationRangeLabel({ summary: "Changed", oldRange: [10, 11], newRange: [20, 21] }, file),
    ).toBe("src/sparse.ts L10–L11 → R20–R21");
  });

  test("keeps hunk-number comments visible when anchored after leading context", () => {
    const file = createContextHeavyHunkFile();
    const hunk = file.metadata.hunks[0]!;

    const target = resolveCommentTarget(file, {
      filePath: file.path,
      hunkIndex: 0,
      summary: "Explain inserted line",
      rationale: "The daemon resolves hunk-number comments to the first change row.",
    });

    expect(target).toMatchObject({ hunkIndex: 0, side: "new", line: 13 });
    expect(hunk.additionLines).toBe(1);
    expect(hunk.additionCount).toBeGreaterThan(target.line - hunk.additionStart + 1);

    const comment = buildLiveComment(
      {
        filePath: file.path,
        side: target.side,
        line: target.line,
        summary: "Explain inserted line",
        rationale: "The daemon resolves hunk-number comments to the first change row.",
      },
      "comment-1",
      "2026-03-22T00:00:00.000Z",
      target.hunkIndex,
    );
    const annotatedFile = {
      ...file,
      agent: {
        path: file.path,
        annotations: [comment],
      },
    };

    expect([...reviewAnnotatedHunkIndices(annotatedFile)]).toEqual([0]);
    expect(getSelectedAnnotations(annotatedFile, hunk)).toEqual([comment]);
  });
});

describe("annotated hunk reveal target", () => {
  /** Two notes on one hunk in NON-anchor order: B hangs above A but arrived second. */
  function fileWithOutOfOrderNotes(): DiffFile {
    const file = createContextHeavyHunkFile();
    return {
      ...file,
      agent: {
        path: file.path,
        annotations: [
          { id: "a", summary: "later line, added first", newRange: [15, 15] },
          { id: "b", summary: "earlier line, added second", newRange: [4, 4] },
        ],
      },
    };
  }

  test("the line target and the revealed note come from the same reveal policy", () => {
    const notes = resolveVisibleReviewNotes(fileWithOutOfOrderNotes(), { showAgentNotes: true });
    const target = annotatedHunkLineTarget(notes, 0);

    const revealPick = resolveReviewRevealNoteId(
      notes.map((note) => ({
        id: note.id,
        line: reviewNoteAnchorLine(note).line,
        draft: note.source === "draft",
      })),
    );
    expect(target?.noteId).toBe(revealPick!);

    // The earliest anchor wins, not the first annotation in file order.
    expect(target).toEqual({
      noteId: "annotation:file:context-heavy-annotation:id:b",
      lineTarget: { side: "new", line: 4 },
    });
  });

  test("a preferred target matching an owned note's anchor overrides the policy winner", () => {
    const notes = resolveVisibleReviewNotes(fileWithOutOfOrderNotes(), { showAgentNotes: true });

    // The policy winner is the earliest anchor (line 4); a completed pick of the other
    // note must reveal that note, not re-run the policy.
    const policy = annotatedHunkLineTarget(notes, 0);
    const other = notes.find((note) => note.id !== policy?.noteId);
    expect(other).toBeDefined();
    const otherAnchor = reviewNoteAnchorLine(other!);

    expect(annotatedHunkLineTarget(notes, 0, otherAnchor)).toEqual({
      noteId: other!.id,
      lineTarget: { side: otherAnchor.side, line: otherAnchor.line },
    });
  });

  test("a preferred target matching no owned note falls back to the policy winner", () => {
    const notes = resolveVisibleReviewNotes(fileWithOutOfOrderNotes(), { showAgentNotes: true });

    expect(annotatedHunkLineTarget(notes, 0, { side: "new", line: 999 })).toEqual(
      annotatedHunkLineTarget(notes, 0),
    );
  });

  test("an open draft outranks every settled note", () => {
    const notes = resolveVisibleReviewNotes(fileWithOutOfOrderNotes(), {
      showAgentNotes: true,
      draft: { id: "draft:1", hunkIndex: 0, side: "new", line: 20, body: "" },
    });

    expect(annotatedHunkLineTarget(notes, 0)).toEqual({
      noteId: "draft:1",
      lineTarget: { side: "new", line: 20 },
    });
  });

  test("resolves to null when the layer hides every note on the hunk", () => {
    const notes = resolveVisibleReviewNotes(fileWithOutOfOrderNotes(), { showAgentNotes: false });

    expect(notes).toEqual([]);
    expect(annotatedHunkLineTarget(notes, 0)).toBeNull();
  });

  test("resolves to null for a hunk that owns no note", () => {
    const notes = resolveVisibleReviewNotes(fileWithOutOfOrderNotes(), { showAgentNotes: true });

    expect(annotatedHunkLineTarget(notes, 1)).toBeNull();
  });
});
