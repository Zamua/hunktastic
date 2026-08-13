import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { MouseButtons } from "@opentui/core/testing";
import { act } from "react";
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

/** Read the background the review stream painted across one rendered code row. */
function rowBackground(setup: Awaited<ReturnType<typeof testRender>>, needle: string) {
  const frame = setup.captureSpans();
  for (const line of frame.lines) {
    const text = line.spans.map((span) => span.text).join("");
    if (!text.includes(needle)) {
      continue;
    }

    // The widest painted run is the code content, not the rail or the gutter.
    const widest = line.spans
      .filter((span) => span.text.trim().length > 0)
      .sort((left, right) => right.text.length - left.text.length)[0];
    if (widest) {
      return { r: widest.bg.r, g: widest.bg.g, b: widest.bg.b };
    }
  }

  throw new Error(`No rendered row contained ${JSON.stringify(needle)}.`);
}

async function renderMenuApp() {
  const setup = await testRender(
    <AppHost
      bootstrap={
        {
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
            initialMode: "stack",
          }),
          initialCursorLine: "row",
        } as never
      }
    />,
    { width: 200, height: 20 },
  );
  await flush(setup);
  await act(async () => {
    await Bun.sleep(60);
    await setup.renderOnce();
  });
  return setup;
}

/** Click one top-level menu title on the menu bar. */
async function clickMenuTitle(setup: Awaited<ReturnType<typeof testRender>>, label: string) {
  const title = locateText(setup, label);
  await act(async () => {
    await setup.mockMouse.click(title.x, title.y, MouseButtons.LEFT);
  });
  await flush(setup);
}

describe("clicking outside an open menu", () => {
  test("closes it", async () => {
    const setup = await renderMenuApp();

    try {
      await clickMenuTitle(setup, "Help");
      expect(setup.captureCharFrame()).toContain("Controls help");

      const code = locateText(setup, "delta = 4");
      await act(async () => {
        await setup.mockMouse.click(code.x + 2, code.y, MouseButtons.LEFT);
      });
      await flush(setup);

      expect(setup.captureCharFrame()).not.toContain("Controls help");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("over the diff does not also move the current line", async () => {
    const setup = await renderMenuApp();

    try {
      const plain = rowBackground(setup, "delta = 4");

      await clickMenuTitle(setup, "Help");
      const code = locateText(setup, "delta = 4");
      await act(async () => {
        await setup.mockMouse.click(code.x + 2, code.y, MouseButtons.LEFT);
      });
      await flush(setup);

      expect(rowBackground(setup, "delta = 4")).toEqual(plain);
      expect(setup.captureCharFrame()).not.toContain("Controls help");

      // The same click with no menu open does move the marker, so the check
      // above is reading a suppressed click rather than an inert target.
      await act(async () => {
        await setup.mockMouse.click(code.x + 2, code.y, MouseButtons.LEFT);
      });
      await flush(setup);

      expect(rowBackground(setup, "delta = 4")).not.toEqual(plain);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("with the wheel dismisses instead of leaving the pointer dead", async () => {
    const setup = await renderMenuApp();

    try {
      await clickMenuTitle(setup, "Help");
      expect(setup.captureCharFrame()).toContain("Controls help");

      const code = locateText(setup, "delta = 4");
      await act(async () => {
        await setup.mockMouse.scroll(code.x + 2, code.y, "down");
      });
      await flush(setup);

      expect(setup.captureCharFrame()).not.toContain("Controls help");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("on another menu title switches menus instead of only closing", async () => {
    const setup = await renderMenuApp();

    try {
      await clickMenuTitle(setup, "Help");
      expect(setup.captureCharFrame()).toContain("Controls help");

      await clickMenuTitle(setup, "File");
      const frame = setup.captureCharFrame();

      expect(frame).toContain("Toggle files/filter focus");
      expect(frame).not.toContain("Controls help");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("on a menu item still runs the item", async () => {
    const setup = await renderMenuApp();

    try {
      await clickMenuTitle(setup, "File");
      expect(setup.captureCharFrame()).toContain("Focus filter");

      const item = locateText(setup, "Focus filter");
      await act(async () => {
        await setup.mockMouse.click(item.x, item.y, MouseButtons.LEFT);
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).not.toContain("Toggle files/filter focus");
      expect(frame).toContain("filter:");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
