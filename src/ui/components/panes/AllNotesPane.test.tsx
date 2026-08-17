import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { capturedTestColorToHex } from "../../../../test/helpers/test-color-helpers";
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
        resolution: "active",
        placeable: true,
        source: "agent",
        summary: "Guard the empty case",
        location: "R13",
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
        resolution: "active",
        placeable: true,
        source: "user",
        summary: "Rename this helper",
        location: "R4",
      },
    ],
  },
  // An orphan group: the note's file left the review, so its stored path is the heading.
  {
    fileId: "",
    label: "src/gone.ts",
    entries: [
      {
        id: "gone",
        fileId: "",
        resolution: "orphaned",
        placeable: false,
        source: "agent",
        summary: "This block loses its guard",
        anchorText: "if (items.length === 0) return;",
      },
    ],
  },
];

/** Mount the pane, run the body against the live render setup, and tear down. */
async function withPane(
  groups: readonly ReviewNoteGroup[],
  selections: Array<[string, string]>,
  body: (setup: Awaited<ReturnType<typeof testRender>>) => Promise<void>,
  currentNoteId: string | null = null,
) {
  const setup = await testRender(
    <AllNotesPane
      groups={groups}
      currentNoteId={currentNoteId}
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
      expect(frame).toContain("orphaned This block loses its guard");
      // The stored anchor text is what keeps an unplaceable note a statement about known code.
      expect(frame).toContain("if (items.length === 0) return;");
    });
  });

  test("heads each file's notes with that file, in the order given", async () => {
    await withPane(GROUPS, [], async (setup) => {
      expect(rowOf(setup, "src/noted.ts")).toBeLessThan(rowOf(setup, "Guard the empty case"));
      expect(rowOf(setup, "Guard the empty case")).toBeLessThan(rowOf(setup, "src/other.ts"));
      expect(rowOf(setup, "src/other.ts")).toBeLessThan(rowOf(setup, "Rename this helper"));
      // Orphan groups trail the review's own files, under their stored path.
      expect(rowOf(setup, "Rename this helper")).toBeLessThan(rowOf(setup, "src/gone.ts"));
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

  test("marks the current note with the file sidebar's selected-row treatment", async () => {
    await withPane(
      GROUPS,
      [],
      async (setup) => {
        const backgrounds = (needle: string) => {
          const spans = setup.captureSpans().lines[rowOf(setup, needle)]?.spans ?? [];
          // Column 0 is the pane's own inset; the row's accent column is the next one.
          let end = 0;
          const accent = spans.find((span) => {
            end += span.text.length;
            return end > 1;
          });
          return {
            accentColumn: capturedTestColorToHex(accent?.bg)?.toLowerCase(),
            row: capturedTestColorToHex(
              spans.find((span) => span.text.includes(needle))?.bg,
            )?.toLowerCase(),
          };
        };

        // Same two tokens a selected file row uses: the accent bar in the first column,
        // panelAlt behind the rest of the row.
        expect(backgrounds("Guard the empty case")).toEqual({
          accentColumn: THEME.accent.toLowerCase(),
          row: THEME.panelAlt.toLowerCase(),
        });
        expect(backgrounds("Rename this helper")).toEqual({
          accentColumn: THEME.panel.toLowerCase(),
          row: THEME.panel.toLowerCase(),
        });
      },
      "placed",
    );
  });

  test("keeps every row inside the pane's own right inset", async () => {
    const long: ReviewNoteGroup[] = [
      {
        fileId: "",
        label: "src/gone.ts",
        entries: [
          {
            id: "gone",
            fileId: "",
            resolution: "orphaned",
            placeable: false,
            source: "agent",
            summary: "A summary long enough to run past the right edge of this pane",
            anchorText: "if (items.length === 0) return earlyExit(alpha, bravo, charlie);",
          },
        ],
      },
    ];

    await withPane(long, [], async (setup) => {
      const rows = setup.captureCharFrame().split("\n");
      const lastColumn = (needle: string) =>
        rows.find((row) => row.includes(needle))?.replace(/\s+$/, "").length ?? 0;

      // The accent column is an indent, not extra room: the wrapped anchor line has to stop
      // where the summary line stops rather than eating the pane's right inset.
      expect(lastColumn("if (items.length")).toBe(lastColumn("A summary long enough"));
    });
  });

  test("says so when the review carries no notes", async () => {
    await withPane([], [], async (setup) => {
      expect(setup.captureCharFrame()).toContain("No notes in this review");
    });
  });
});
