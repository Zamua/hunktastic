import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { MouseButtons } from "@opentui/core/testing";
import { act } from "react";
import type { CursorLine } from "../core/types";
import { createTestVcsAppBootstrap } from "../../test/helpers/app-bootstrap";
import { createTestDiffFile, lines } from "../../test/helpers/diff-helpers";
import { AppHost } from "./AppHost";

const BEFORE = lines(
  "const alpha = 1;",
  "const beta = 2;",
  "const gamma = 3;",
  "const delta = 4;",
  "const epsilon = 5;",
);
const AFTER = lines(
  "const alpha = 1;",
  "const beta = 22222;",
  "const gamma = 3;",
  "const delta = 4;",
  "const epsilon = 5;",
);

async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

function createCursorLineBootstrap(
  cursorLine: CursorLine,
  initialMode: "split" | "stack" = "stack",
) {
  return {
    ...createTestVcsAppBootstrap({
      files: [
        createTestDiffFile({
          id: "s",
          path: "sample.ts",
          before: BEFORE,
          after: AFTER,
          context: 3,
        }),
      ],
      initialMode,
    }),
    initialCursorLine: cursorLine,
  };
}

/** Read the background the review stream painted across one rendered code row. */
function rowBackground(setup: Awaited<ReturnType<typeof testRender>>, needle: string) {
  const frame = setup.captureSpans();
  for (const line of frame.lines) {
    const text = line.spans.map((span) => span.text).join("");
    if (!text.includes(needle)) {
      continue;
    }

    // The widest painted run is the code content, not the rail or the line-number gutter.
    const widest = line.spans
      .filter((span) => span.text.trim().length > 0)
      .sort((left, right) => right.text.length - left.text.length)[0];
    if (widest) {
      return { r: widest.bg.r, g: widest.bg.g, b: widest.bg.b };
    }
  }

  throw new Error(`No rendered row contained ${JSON.stringify(needle)}.`);
}

/** Read the background painted behind one rendered row's line-number gutter. */
function gutterBackground(setup: Awaited<ReturnType<typeof testRender>>, needle: string) {
  const frame = setup.captureSpans();
  for (const line of frame.lines) {
    const text = line.spans.map((span) => span.text).join("");
    if (!text.includes(needle)) {
      continue;
    }

    const gutter = line.spans.find((span) => /\d/.test(span.text));
    if (gutter) {
      return { r: gutter.bg.r, g: gutter.bg.g, b: gutter.bg.b };
    }
  }

  throw new Error(`No rendered gutter for ${JSON.stringify(needle)}.`);
}

/** Find the screen position of the first occurrence of `needle` in the rendered frame. */
function locateText(setup: Awaited<ReturnType<typeof testRender>>, needle: string) {
  const rows = setup.captureCharFrame().split("\n");
  for (let y = 0; y < rows.length; y += 1) {
    const x = rows[y]?.indexOf(needle) ?? -1;
    if (x >= 0) {
      return { x, y };
    }
  }

  throw new Error(`No rendered row contained ${JSON.stringify(needle)}.`);
}

async function renderCursorLineApp(
  cursorLine: CursorLine,
  initialMode: "split" | "stack" = "stack",
) {
  const setup = await testRender(
    <AppHost bootstrap={createCursorLineBootstrap(cursorLine, initialMode) as never} />,
    { width: 200, height: 16 },
  );
  await flush(setup);
  await act(async () => {
    await Bun.sleep(60);
    await setup.renderOnce();
  });
  return setup;
}

/** Render a long wrapped CJK addition through the split-row chunk path. */
async function renderWrappedCursorLineApp(cursorLine: CursorLine) {
  const content = `export const message = "${"日本語".repeat(80)}";\n`;
  const bootstrap = {
    ...createTestVcsAppBootstrap({
      files: [
        createTestDiffFile({
          id: "wrapped",
          path: "wrapped.ts",
          before: "",
          after: content,
          context: 3,
        }),
      ],
      initialMode: "split",
      initialWrapLines: true,
    }),
    initialCursorLine: cursorLine,
  };
  const setup = await testRender(<AppHost bootstrap={bootstrap as never} />, {
    width: 120,
    height: 16,
  });
  await flush(setup);
  return setup;
}

describe("current line highlight", () => {
  test("marks the current row apart from the rows around it", async () => {
    const setup = await renderCursorLineApp("row");

    try {
      expect(rowBackground(setup, "alpha = 1")).not.toEqual(rowBackground(setup, "gamma = 3"));
      expect(rowBackground(setup, "gamma = 3")).toEqual(rowBackground(setup, "delta = 4"));
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("keeps added and removed lines telling themselves apart under the highlight", async () => {
    const setup = await renderCursorLineApp("row");

    try {
      await act(async () => {
        await setup.mockInput.typeText("j");
      });
      await flush(setup);
      const removed = rowBackground(setup, "beta = 2;");
      expect(removed.r).toBeGreaterThan(removed.g);

      await act(async () => {
        await setup.mockInput.typeText("j");
      });
      await flush(setup);
      const added = rowBackground(setup, "beta = 22222");
      expect(added.g).toBeGreaterThan(added.r);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("lifts added and removed rows as far as it lifts context rows", async () => {
    const marked = await renderCursorLineApp("row");
    const plain = await renderCursorLineApp("off");

    /** Compare one row's marked and unmarked paint the way a reader perceives it. */
    const lift = (needle: string) => {
      const a = rowBackground(marked, needle);
      const b = rowBackground(plain, needle);
      return Math.abs(a.r + a.g + a.b - (b.r + b.g + b.b));
    };

    try {
      for (let step = 0; step < 2; step += 1) {
        await act(async () => {
          await marked.mockInput.typeText("j");
        });
        await flush(marked);
      }

      const addedLift = lift("beta = 22222");
      const contextLift = lift("alpha = 1");
      expect(addedLift).toBeGreaterThan(0.1);
      expect(addedLift).toBeGreaterThan(contextLift * 0.5);
    } finally {
      await act(async () => {
        marked.renderer.destroy();
        plain.renderer.destroy();
      });
    }
  });

  test("number style marks the gutter without repainting the code", async () => {
    const setup = await renderCursorLineApp("number");
    const plain = await renderCursorLineApp("off");

    try {
      expect(rowBackground(setup, "alpha = 1")).toEqual(rowBackground(plain, "alpha = 1"));
      expect(gutterBackground(setup, "alpha = 1")).not.toEqual(
        gutterBackground(plain, "alpha = 1"),
      );
    } finally {
      await act(async () => {
        setup.renderer.destroy();
        plain.renderer.destroy();
      });
    }
  });

  test("marks both halves of a split context row", async () => {
    const setup = await renderCursorLineApp("row", "split");

    try {
      expect(rowBackground(setup, "alpha = 1")).not.toEqual(rowBackground(setup, "gamma = 3"));
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("marks a wrapped CJK row through the chunk renderer", async () => {
    const marked = await renderWrappedCursorLineApp("row");
    const plain = await renderWrappedCursorLineApp("off");

    try {
      expect(rowBackground(marked, "日本語日本語")).not.toEqual(
        rowBackground(plain, "日本語日本語"),
      );
    } finally {
      await act(async () => {
        marked.renderer.destroy();
        plain.renderer.destroy();
      });
    }
  });

  test("moves to the code row the reviewer clicks", async () => {
    const setup = await renderCursorLineApp("row");

    try {
      const target = locateText(setup, "delta = 4");
      await act(async () => {
        await setup.mockMouse.click(target.x + 2, target.y, MouseButtons.LEFT);
      });
      await flush(setup);

      expect(rowBackground(setup, "delta = 4")).not.toEqual(rowBackground(setup, "epsilon = 5"));
      // The row the marker started on releases it, so the click moved rather than added a mark.
      expect(rowBackground(setup, "alpha = 1")).toEqual(rowBackground(setup, "epsilon = 5"));
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("stays put when the click lands on a row that is not source code", async () => {
    const setup = await renderCursorLineApp("row");

    try {
      const code = locateText(setup, "delta = 4");
      await act(async () => {
        await setup.mockMouse.click(code.x + 2, code.y, MouseButtons.LEFT);
      });
      await flush(setup);

      const hunkHeader = locateText(setup, "@@");
      await act(async () => {
        await setup.mockMouse.click(hunkHeader.x + 2, hunkHeader.y, MouseButtons.LEFT);
      });
      await flush(setup);

      expect(rowBackground(setup, "delta = 4")).not.toEqual(rowBackground(setup, "epsilon = 5"));
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("leaves the current line alone while a drag selects text", async () => {
    const setup = await renderCursorLineApp("row");
    const copied: string[] = [];
    setup.renderer.isOsc52Supported = () => true;
    setup.renderer.copyToClipboardOSC52 = (text: string) => {
      copied.push(text);
      return true;
    };

    try {
      const start = locateText(setup, "delta = 4");
      const end = locateText(setup, "epsilon = 5");
      await act(async () => {
        await setup.mockMouse.drag(start.x, start.y, end.x + 6, end.y, MouseButtons.LEFT);
      });
      await flush(setup);

      expect(copied.join("\n")).toContain("delta");
      // The drag pressed on the delta row; the marker still belongs to the row it started on.
      expect(rowBackground(setup, "alpha = 1")).not.toEqual(rowBackground(setup, "gamma = 3"));
      expect(rowBackground(setup, "delta = 4")).toEqual(rowBackground(setup, "gamma = 3"));
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("off style leaves every row painted the same", async () => {
    const setup = await renderCursorLineApp("off");

    try {
      expect(rowBackground(setup, "alpha = 1")).toEqual(rowBackground(setup, "gamma = 3"));
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
