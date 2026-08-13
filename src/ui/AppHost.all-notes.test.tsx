import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createTestVcsAppBootstrap } from "../../test/helpers/app-bootstrap";
import { createTestDiffFile, lines } from "../../test/helpers/diff-helpers";
import { AppHost } from "./AppHost";

const BEFORE = lines(
  "const alpha = 1;",
  "const filler1 = 1;",
  "const filler2 = 2;",
  "const filler3 = 3;",
  "const filler4 = 4;",
  "const omega = 9;",
);
const AFTER = lines(
  "const alpha = 111;",
  "const filler1 = 1;",
  "const filler2 = 2;",
  "const filler3 = 3;",
  "const filler4 = 4;",
  "const omega = 999;",
);

function createNotesBootstrap() {
  const file = createTestDiffFile({
    after: AFTER,
    before: BEFORE,
    context: 0,
    id: "noted",
    path: "noted.ts",
  });

  return {
    ...createTestVcsAppBootstrap({
      files: [
        {
          ...file,
          agent: {
            path: file.path,
            annotations: [
              {
                id: "omega-note",
                summary: "Bump the omega constant",
                newRange: [6, 6] as [number, number],
              },
            ],
          },
        },
      ],
      initialMode: "stack",
    }),
    initialCursorLine: "row",
  };
}

async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
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

/** Find the screen position of the first occurrence of one string in the rendered frame. */
function locate(setup: Awaited<ReturnType<typeof testRender>>, needle: string) {
  const rows = setup.captureCharFrame().split("\n");
  for (let y = 0; y < rows.length; y += 1) {
    const x = rows[y]?.indexOf(needle) ?? -1;
    if (x >= 0) {
      return { x, y };
    }
  }

  throw new Error(`No rendered row contained ${JSON.stringify(needle)}.`);
}

async function renderNotesApp() {
  const setup = await testRender(<AppHost bootstrap={createNotesBootstrap() as never} />, {
    width: 200,
    height: 20,
  });
  await flush(setup);
  await act(async () => {
    await Bun.sleep(60);
    await setup.renderOnce();
  });
  return setup;
}

describe("all notes sidebar", () => {
  test("opens and closes on n", async () => {
    const setup = await renderNotesApp();

    try {
      expect(setup.captureCharFrame()).not.toContain("Bump the omega constant");

      await act(async () => {
        await setup.mockInput.typeText("n");
      });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("Bump the omega constant");

      await act(async () => {
        await setup.mockInput.typeText("n");
      });
      await flush(setup);
      expect(setup.captureCharFrame()).not.toContain("Bump the omega constant");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("selecting a note puts the current line on the line the note is about", async () => {
    const setup = await renderNotesApp();

    try {
      await act(async () => {
        await setup.mockInput.typeText("n");
      });
      await flush(setup);

      // The review opens on the first hunk, so its removed row carries the marker and the
      // second hunk's rows are painted plainly.
      expect(rowBackground(setup, "alpha = 1;")).not.toEqual(rowBackground(setup, "omega = 9;"));
      const plainAddition = rowBackground(setup, "omega = 999");

      const row = locate(setup, "Bump the omega constant");
      await act(async () => {
        await setup.mockMouse.click(row.x, row.y);
      });
      await flush(setup);

      // The marker moved onto the note's own line, and off the row it started on.
      expect(rowBackground(setup, "omega = 999")).not.toEqual(plainAddition);
      expect(rowBackground(setup, "alpha = 1;")).toEqual(rowBackground(setup, "omega = 9;"));
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
