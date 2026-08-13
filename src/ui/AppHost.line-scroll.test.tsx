import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createTestVcsAppBootstrap } from "../../test/helpers/app-bootstrap";
import { createTestDiffFile, lines } from "../../test/helpers/diff-helpers";
import { AppHost } from "./AppHost";

const BEFORE = Array.from({ length: 40 }, (_, index) => `const line${index + 1} = ${index + 1};`);
const AFTER = BEFORE.map((line, index) => (index === 19 ? "const line20 = 2000;" : line));

/** Render, then let the scroll and the clamp it triggers settle into one frame. */
async function settle(setup: Awaited<ReturnType<typeof testRender>>, cycles = 3) {
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(20);
      await setup.renderOnce();
    });
  }
}

/** Read the background the review stream painted across one rendered code row. */
function rowBackground(setup: Awaited<ReturnType<typeof testRender>>, needle: string) {
  const frame = setup.captureSpans();
  for (const line of frame.lines) {
    const text = line.spans.map((span) => span.text).join("");
    if (!text.includes(needle)) {
      continue;
    }

    const widest = line.spans
      .filter((span) => span.text.trim().length > 0)
      .sort((left, right) => right.text.length - left.text.length)[0];
    if (widest) {
      return { r: widest.bg.r, g: widest.bg.g, b: widest.bg.b };
    }
  }

  throw new Error(`No rendered row contained ${JSON.stringify(needle)}.`);
}

/** Report whether the current-line marker sits on one rendered row. */
function isMarked(setup: Awaited<ReturnType<typeof testRender>>, needle: string, plain: string) {
  return (
    JSON.stringify(rowBackground(setup, needle)) !== JSON.stringify(rowBackground(setup, plain))
  );
}

/** Render one file tall enough that the review has somewhere to scroll. */
async function renderLongFileApp() {
  const bootstrap = {
    ...createTestVcsAppBootstrap({
      files: [
        createTestDiffFile({
          after: lines(...AFTER),
          before: lines(...BEFORE),
          // Every line renders, so the review is one long stream with no collapsed gaps.
          context: 100,
          id: "long",
          path: "long.ts",
        }),
      ],
      initialMode: "stack",
    }),
    initialCursorLine: "row",
  };
  const setup = await testRender(<AppHost bootstrap={bootstrap as never} />, {
    width: 120,
    height: 16,
  });
  await settle(setup);
  return setup;
}

/** Press one chord and let the resulting scroll land. */
async function press(
  setup: Awaited<ReturnType<typeof testRender>>,
  key: string,
  times: number = 1,
) {
  for (let count = 0; count < times; count += 1) {
    await act(async () => {
      setup.mockInput.pressKey(key, { ctrl: true });
    });
    await settle(setup, 2);
  }
}

describe("ctrl+e and ctrl+y", () => {
  test("move the view and leave the current line where it is", async () => {
    const setup = await renderLongFileApp();

    try {
      expect(setup.captureCharFrame()).toContain("@@ -1,40 +1,40 @@");
      expect(isMarked(setup, "const line1 = 1;", "const line2 = 2;")).toBe(true);

      await press(setup, "e");

      // The hunk header scrolled off the top, so the view moved; the marker did not.
      expect(setup.captureCharFrame()).not.toContain("@@ -1,40 +1,40 @@");
      expect(isMarked(setup, "const line1 = 1;", "const line2 = 2;")).toBe(true);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("clamp the current line to the nearest still-visible row", async () => {
    const setup = await renderLongFileApp();

    try {
      await press(setup, "e", 4);

      // The row the marker started on left the viewport, so the marker moved down to the top
      // row rather than leaving the screen with it.
      expect(setup.captureCharFrame()).not.toContain("const line1 = 1;");
      expect(isMarked(setup, "const line4 = 4;", "const line5 = 5;")).toBe(true);

      // Scrolling back up reveals the row above again and still leaves the marker alone.
      await press(setup, "y");
      expect(setup.captureCharFrame()).toContain("const line3 = 3;");
      expect(isMarked(setup, "const line4 = 4;", "const line5 = 5;")).toBe(true);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("j still carries the current line rather than scrolling under it", async () => {
    const setup = await renderLongFileApp();

    try {
      await act(async () => {
        await setup.mockInput.typeText("j");
      });
      await settle(setup, 2);

      // The view has not moved, and the marker stepped onto the next row.
      expect(setup.captureCharFrame()).toContain("@@ -1,40 +1,40 @@");
      expect(isMarked(setup, "const line2 = 2;", "const line3 = 3;")).toBe(true);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
