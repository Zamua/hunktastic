import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { toExtensionPaintTheme } from "../../lib/extensionPaintTheme";
import type { ReviewNoteEntry } from "../../lib/reviewNotes";
import { resolveTheme } from "../../themes";
import { AllNotesPane } from "./AllNotesPane";

const THEME = toExtensionPaintTheme(resolveTheme("github-dark-default", null));

const ENTRIES: ReviewNoteEntry[] = [
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
];

/** Mount the pane, run the body against the live render setup, and tear down. */
async function withPane(
  entries: readonly ReviewNoteEntry[],
  selections: Array<[string, string]>,
  body: (setup: Awaited<ReturnType<typeof testRender>>) => Promise<void>,
) {
  const setup = await testRender(
    <AllNotesPane
      entries={entries}
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
    await withPane(ENTRIES, [], async (setup) => {
      const frame = setup.captureCharFrame();

      expect(frame).toContain("R13 Guard the empty case");
      expect(frame).toContain("unanchored This block loses its guard");
      // The stored anchor text is what keeps an unplaceable note a statement about known code.
      expect(frame).toContain("if (items.length === 0) return;");
    });
  });

  test("selects a placed note and leaves an unplaceable one inert", async () => {
    const selections: Array<[string, string]> = [];

    await withPane(ENTRIES, selections, async (setup) => {
      await act(async () => {
        await setup.mockMouse.click(4, rowOf(setup, "Guard the empty case"));
      });
      expect(selections).toEqual([["file:noted", "placed"]]);

      await act(async () => {
        await setup.mockMouse.click(4, rowOf(setup, "This block loses its guard"));
        await setup.mockMouse.click(4, rowOf(setup, "if (items.length === 0) return;"));
      });
      expect(selections).toEqual([["file:noted", "placed"]]);
    });
  });

  test("says so when the selected file carries no notes", async () => {
    await withPane([], [], async (setup) => {
      expect(setup.captureCharFrame()).toContain("No notes on this file");
    });
  });
});
