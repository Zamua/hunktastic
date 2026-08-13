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
const SECOND_BEFORE = lines(
  "const zeta = 1;",
  "const spacer1 = 1;",
  "const spacer2 = 2;",
  "const kappa = 9;",
);
const SECOND_AFTER = lines(
  "const zeta = 1;",
  "const spacer1 = 1;",
  "const spacer2 = 2;",
  "const kappa = 999;",
);

function createNotesBootstrap() {
  const file = createTestDiffFile({
    after: AFTER,
    before: BEFORE,
    context: 0,
    id: "noted",
    path: "noted.ts",
  });
  const second = createTestDiffFile({
    after: SECOND_AFTER,
    before: SECOND_BEFORE,
    context: 0,
    id: "second",
    path: "second.ts",
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
        {
          ...second,
          agent: {
            path: second.path,
            annotations: [
              {
                id: "kappa-note",
                summary: "Rename the kappa constant",
                newRange: [4, 4] as [number, number],
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

/**
 * Read what the all-notes pane rendered, one trimmed line per row.
 *
 * The pane is the column right of the last divider, so this reads it without
 * matching the file headers the review stream draws for the same files.
 */
function notesPaneLines(setup: Awaited<ReturnType<typeof testRender>>) {
  const rows = setup.captureCharFrame().split("\n");
  const dividerColumn = Math.max(...rows.map((row) => row.lastIndexOf("│")));
  if (dividerColumn < 0) {
    throw new Error("No pane divider rendered.");
  }

  return rows
    .map((row) => row.slice(dividerColumn + 1).trim())
    .filter((row) => row.length > 0 && !row.startsWith("─"));
}

/** Report whether the file sidebar is on screen; only its rows carry the status prefix. */
function fileSidebarVisible(setup: Awaited<ReturnType<typeof testRender>>) {
  return setup.captureCharFrame().includes("M noted.ts");
}

async function renderNotesApp(width = 200) {
  const setup = await testRender(<AppHost bootstrap={createNotesBootstrap() as never} />, {
    width,
    height: 22,
  });
  await flush(setup);
  await act(async () => {
    await Bun.sleep(60);
    await setup.renderOnce();
  });
  return setup;
}

describe("all notes sidebar", () => {
  test("opens and closes on a", async () => {
    const setup = await renderNotesApp();

    try {
      expect(setup.captureCharFrame()).not.toContain("Bump the omega constant");

      await act(async () => {
        await setup.mockInput.typeText("a");
      });
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("Bump the omega constant");

      await act(async () => {
        await setup.mockInput.typeText("a");
      });
      await flush(setup);
      expect(setup.captureCharFrame()).not.toContain("Bump the omega constant");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("lists every file's notes, grouped under the file they belong to", async () => {
    const setup = await renderNotesApp();

    try {
      await act(async () => {
        await setup.mockInput.typeText("a");
      });
      await flush(setup);

      expect(notesPaneLines(setup)).toEqual([
        "noted.ts",
        "R6 Bump the omega constant",
        "second.ts",
        "R4 Rename the kappa constant",
      ]);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("opening and closing it leaves the file sidebar exactly as it was", async () => {
    // Wide enough that the sidebar area shows by default.
    const shown = await renderNotesApp(230);
    // Narrow enough that the responsive layout hides it.
    const hidden = await renderNotesApp(200);

    try {
      expect(fileSidebarVisible(shown)).toBe(true);
      expect(fileSidebarVisible(hidden)).toBe(false);

      for (const setup of [shown, hidden]) {
        await act(async () => {
          await setup.mockInput.typeText("a");
        });
        await flush(setup);
      }

      expect(shown.captureCharFrame()).toContain("Bump the omega constant");
      expect(hidden.captureCharFrame()).toContain("Bump the omega constant");
      expect(fileSidebarVisible(shown)).toBe(true);
      expect(fileSidebarVisible(hidden)).toBe(false);

      for (const setup of [shown, hidden]) {
        await act(async () => {
          await setup.mockInput.typeText("a");
        });
        await flush(setup);
      }

      expect(shown.captureCharFrame()).not.toContain("Bump the omega constant");
      expect(fileSidebarVisible(shown)).toBe(true);
      expect(fileSidebarVisible(hidden)).toBe(false);
    } finally {
      await act(async () => {
        shown.renderer.destroy();
        hidden.renderer.destroy();
      });
    }
  });

  test("selecting a note from another file moves the review onto that file", async () => {
    const setup = await renderNotesApp();

    try {
      await act(async () => {
        await setup.mockInput.typeText("a");
      });
      await flush(setup);

      // The review opens on the first file, so its first hunk carries the marker.
      expect(rowBackground(setup, "alpha = 1;")).not.toEqual(rowBackground(setup, "omega = 9;"));
      const plainAddition = rowBackground(setup, "kappa = 999");

      const row = locate(setup, "Rename the kappa constant");
      await act(async () => {
        await setup.mockMouse.click(row.x, row.y);
      });
      await flush(setup);

      // The marker crossed the file boundary onto the note's own line, and the file it left
      // holds no marker at all.
      expect(rowBackground(setup, "kappa = 999")).not.toEqual(plainAddition);
      expect(rowBackground(setup, "alpha = 1;")).toEqual(rowBackground(setup, "omega = 9;"));
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
        await setup.mockInput.typeText("a");
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
