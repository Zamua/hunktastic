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
async function renderLongFileApp(cursorLine: "row" | "off") {
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
    initialCursorLine: cursorLine,
  };
  const setup = await testRender(<AppHost bootstrap={bootstrap as never} />, {
    width: 120,
    height: 16,
  });
  await settle(setup);
  return setup;
}

/** Press one key and let the resulting move land. */
async function press(
  setup: Awaited<ReturnType<typeof testRender>>,
  key: string,
  times: number = 1,
) {
  for (let count = 0; count < times; count += 1) {
    await act(async () => {
      setup.mockInput.pressKey(key);
    });
    await settle(setup, 2);
  }
}

describe("j and k", () => {
  test("move the view when the current-line marker is off, which is the default", async () => {
    const setup = await renderLongFileApp("off");

    try {
      expect(setup.captureCharFrame()).toContain("@@ -1,40 +1,40 @@");

      await press(setup, "j");

      // The hunk header scrolled off the top, so the viewport moved rather than
      // a cursor walking down it.
      expect(setup.captureCharFrame()).not.toContain("@@ -1,40 +1,40 @@");

      await press(setup, "k");
      expect(setup.captureCharFrame()).toContain("@@ -1,40 +1,40 @@");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("move the marker instead once the current line is turned on", async () => {
    const setup = await renderLongFileApp("row");

    try {
      expect(isMarked(setup, "const line1 = 1;", "const line2 = 2;")).toBe(true);

      await press(setup, "j");

      // The marker advanced and the view stayed put: turning the marker on is
      // what swaps j/k from scrolling to stepping.
      expect(setup.captureCharFrame()).toContain("@@ -1,40 +1,40 @@");
      expect(isMarked(setup, "const line2 = 2;", "const line3 = 3;")).toBe(true);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
