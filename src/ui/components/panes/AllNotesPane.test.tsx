import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { toExtensionPaintTheme } from "../../lib/extensionPaintTheme";
import type { ReviewNoteGroup } from "../../lib/reviewNotes";
import { resolveTheme } from "../../themes";
import { AllNotesPane } from "./AllNotesPane";

const THEME = toExtensionPaintTheme(resolveTheme("github-dark-default", null));

const GROUPS: ReviewNoteGroup[] = [
  {
    fileId: "file:noted",
    label: "src/noted.ts",
    entries: [
      {
        id: "placed",
        fileId: "file:noted",
        state: "anchored",
        placeable: true,
        source: "agent",
        summary: "Guard the empty case",
        location: "R13",
      },
      {
        id: "gone",
        fileId: "file:noted",
        state: "unanchored",
        placeable: false,
        source: "agent",
        summary: "This block loses its guard",
        anchorText: "if (items.length === 0) return;",
      },
    ],
  },
  {
    fileId: "file:other",
    label: "src/other.ts",
    entries: [
      {
        id: "elsewhere",
        fileId: "file:other",
        state: "anchored",
        placeable: true,
        source: "user",
        summary: "Rename this helper",
        location: "R4",
      },
    ],
  },
];

/** Mount the pane, run the body against the live render setup, and tear down. */
async function withPane(
  groups: readonly ReviewNoteGroup[],
  selections: Array<[string, string]>,
  body: (setup: Awaited<ReturnType<typeof testRender>>) => Promise<void>,
) {
  const setup = await testRender(
    <AllNotesPane
      groups={groups}
      width={40}
      theme={THEME}
      onSelectNote={(fileId, noteId) => selections.push([fileId, noteId])}
    />,
    { width: 40, height: 12 },
  );

  try {
    await act(async () => {
      await setup.renderOnce();
    });
    await body(setup);
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}

/** Find the row a piece of rendered text sits on. */
function rowOf(setup: Awaited<ReturnType<typeof testRender>>, needle: string) {
  const rows = setup.captureCharFrame().split("\n");
  const y = rows.findIndex((row) => row.includes(needle));
  if (y < 0) {
    throw new Error(`No rendered row contained ${JSON.stringify(needle)}.`);
  }

  return y;
}

describe("all notes pane", () => {
  test("lists every note, marking the ones this diff has no line for", async () => {
    await withPane(GROUPS, [], async (setup) => {
      const frame = setup.captureCharFrame();

      expect(frame).toContain("R13 Guard the empty case");
      expect(frame).toContain("unanchored This block loses its guard");
      // The stored anchor text is what keeps an unplaceable note a statement about known code.
      expect(frame).toContain("if (items.length === 0) return;");
    });
  });

  test("heads each file's notes with that file, in the order given", async () => {
    await withPane(GROUPS, [], async (setup) => {
      expect(rowOf(setup, "src/noted.ts")).toBeLessThan(rowOf(setup, "Guard the empty case"));
      expect(rowOf(setup, "Guard the empty case")).toBeLessThan(rowOf(setup, "src/other.ts"));
      expect(rowOf(setup, "src/other.ts")).toBeLessThan(rowOf(setup, "Rename this helper"));
    });
  });

  test("selects a placed note and leaves an unplaceable one inert", async () => {
    const selections: Array<[string, string]> = [];

    await withPane(GROUPS, selections, async (setup) => {
      await act(async () => {
        await setup.mockMouse.click(4, rowOf(setup, "Guard the empty case"));
      });
      expect(selections).toEqual([["file:noted", "placed"]]);

      // A row from another file reports that file, not the one above it in the list.
      await act(async () => {
        await setup.mockMouse.click(4, rowOf(setup, "Rename this helper"));
      });
      expect(selections).toEqual([
        ["file:noted", "placed"],
        ["file:other", "elsewhere"],
      ]);

      await act(async () => {
        await setup.mockMouse.click(4, rowOf(setup, "This block loses its guard"));
        await setup.mockMouse.click(4, rowOf(setup, "if (items.length === 0) return;"));
      });
      expect(selections).toEqual([
        ["file:noted", "placed"],
        ["file:other", "elsewhere"],
      ]);
    });
  });

  test("says so when the review carries no notes", async () => {
    await withPane([], [], async (setup) => {
      expect(setup.captureCharFrame()).toContain("No notes in this review");
    });
  });
});
