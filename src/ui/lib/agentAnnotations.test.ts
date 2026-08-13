import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../test/helpers/diff-helpers";
import { buildLiveComment, resolveCommentTarget } from "../../core/liveComments";
import {
  annotatedHunkLineTarget,
  annotationRangeLabel,
  getAnnotatedHunkIndices,
  getSelectedAnnotations,
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

    expect([...getAnnotatedHunkIndices(annotatedFile)]).toEqual([0]);
    expect(getSelectedAnnotations(annotatedFile, hunk)).toEqual([comment]);
  });

  test("takes the jump target from the hunk's first anchorable annotation", () => {
    const file = createContextHeavyHunkFile();
    const annotatedFile = {
      ...file,
      agent: {
        path: file.path,
        annotations: [
          { summary: "Whole changeset" },
          { summary: "Old side", oldRange: [8, 9] as [number, number] },
          { summary: "New side", newRange: [13, 13] as [number, number] },
        ],
      },
    };

    // The range-less note carries no anchor, so the first note that names lines owns the target.
    expect(annotatedHunkLineTarget(annotatedFile, 0)).toEqual({ side: "old", line: 8 });
  });

  test("gives no jump target for a hunk without annotations", () => {
    const file = createContextHeavyHunkFile();

    expect(annotatedHunkLineTarget(file, 0)).toBeNull();
    expect(annotatedHunkLineTarget(undefined, 0)).toBeNull();
  });

  test("keeps notes whose line this diff no longer holds out of the inline layer", () => {
    const file = createContextHeavyHunkFile();
    const placed = { summary: "Still here", newRange: [13, 13] as [number, number] };
    const unanchored = {
      summary: "Line is gone",
      newRange: [13, 13] as [number, number],
      restored: { state: "unanchored" as const, confidence: "high" as const, anchorText: "line12" },
    };
    const annotatedFile = {
      ...file,
      agent: { path: file.path, annotations: [placed, unanchored] },
    };

    expect(getSelectedAnnotations(annotatedFile, file.metadata.hunks[0]!)).toEqual([placed]);
    expect(annotatedHunkLineTarget(annotatedFile, 0)).toEqual({ side: "new", line: 13 });
    expect([
      ...getAnnotatedHunkIndices({
        ...file,
        agent: { path: file.path, annotations: [unanchored] },
      }),
    ]).toEqual([]);
  });
});
