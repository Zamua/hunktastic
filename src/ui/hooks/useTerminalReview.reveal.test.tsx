import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useEffect, useState } from "react";
import { resolveReviewRevealNoteId } from "../../core/review/selectors";
import type { DiffFile } from "../../core/types";
import { createTestDiffFile, lines } from "../../../test/helpers/diff-helpers";
import { lineStableKey } from "../diff/reviewRenderPlan";
import type { LineCursor } from "../lib/lineCursors";
import { useTerminalReview, type TerminalReview } from "./useTerminalReview";

const BASE_LINES = Array.from(
  { length: 30 },
  (_, index) => `const line${index + 1} = ${index + 1};`,
);

/** One two-hunk fixture: line 5 and line 25 changed, three context lines apart. */
function twoHunkFile(): DiffFile {
  const after = [...BASE_LINES];
  after[4] = "const line5 = 500;";
  after[24] = "const line25 = 2500;";
  return createTestDiffFile({
    after: lines(...after),
    before: lines(...BASE_LINES),
    context: 3,
    id: "alpha.ts",
    path: "alpha.ts",
  });
}

/** Measured-stream stand-in: one new-side stop per line either hunk renders. */
function cursorsFor(file: DiffFile): LineCursor[] {
  return file.metadata.hunks.flatMap((hunk, hunkIndex) => {
    const start = hunk.additionStart;
    const count = hunk.additionCount;
    return Array.from({ length: count }, (_, offset): LineCursor => {
      const line = start + offset;
      return {
        fileId: file.id,
        hunkIndex,
        stableKey: lineStableKey(hunkIndex, "new", line),
        target: { side: "new", line },
      };
    });
  });
}

function RevealHarness({
  files,
  lineCursors,
  onController,
}: {
  files: DiffFile[];
  lineCursors: LineCursor[];
  onController: (controller: TerminalReview) => void;
}) {
  const [review] = useState({ files, lineCursors, initialShowAgentNotes: true });
  const controller = useTerminalReview(review);

  useEffect(() => {
    onController(controller);
  }, [controller, onController]);

  return null;
}

async function renderRevealController(files: DiffFile[], lineCursors: LineCursor[]) {
  const controllerRef: { current: TerminalReview | null } = { current: null };
  const setup = await testRender(
    <RevealHarness
      files={files}
      lineCursors={lineCursors}
      onController={(controller) => {
        controllerRef.current = controller;
      }}
    />,
    { width: 80, height: 4 },
  );

  const settle = async () => {
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(5);
      await setup.renderOnce();
    });
  };

  const destroy = async () => {
    await act(async () => {
      setup.renderer.destroy();
    });
  };

  await settle();
  return { controllerRef, destroy, settle };
}

describe("useTerminalReview annotated-hunk reveal", () => {
  // The 5d property: with two notes on one hunk in NON-anchor order (the second-arrived
  // note anchored above the first), the current line lands on the note the shared reveal
  // policy picks, never on the first note in file order.
  test("an annotated-hunk step lands the current line on the note the reveal picks", async () => {
    const file = twoHunkFile();
    const { controllerRef, destroy, settle } = await renderRevealController(
      [file],
      cursorsFor(file),
    );

    try {
      const controller = controllerRef.current!;
      expect(controller.getSelection()).toEqual({ fileId: "alpha.ts", hunkIndex: 0 });

      // Hunk 1 gets note "a" on its later line first, then note "b" above it.
      await act(async () => {
        controllerRef.current!.addLiveComment(
          { filePath: "alpha.ts", side: "new", line: 27, summary: "later line, added first" },
          "mcp:a",
        );
        controllerRef.current!.addLiveComment(
          { filePath: "alpha.ts", side: "new", line: 23, summary: "earlier line, added second" },
          "mcp:b",
        );
      });
      await settle();

      await act(async () => {
        controllerRef.current!.moveSelection("annotated-hunk", 1);
      });
      await settle();

      const landed = controllerRef.current!;
      expect(landed.getSelection()).toEqual({ fileId: "alpha.ts", hunkIndex: 1 });

      // The reveal policy's own pick over the same candidates, in arrival order.
      const revealPick = resolveReviewRevealNoteId([
        { id: "mcp:a", line: 27 },
        { id: "mcp:b", line: 23 },
      ]);
      expect(revealPick).toBe("mcp:b");

      const cursor = landed.getLineCursor();
      expect(cursor).toMatchObject({
        fileId: "alpha.ts",
        hunkIndex: 1,
        target: { side: "new", line: 23 },
      });
    } finally {
      await destroy();
    }
  });
});
