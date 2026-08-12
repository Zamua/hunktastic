import { describe, expect, test } from "bun:test";
import { contrastRatio } from "../lib/color";
import { THEMES, TRANSPARENT_BACKGROUND, withTransparentSurfaces } from "../themes";
import type { SplitLineCell, StackLineCell } from "./pierre";
import {
  cursorLineHighlightBg,
  splitCellPalette,
  splitGutterText,
  stackCellPalette,
  stackGutterText,
} from "./rowStyle";

const DARK = THEMES.find((theme) => theme.id === "github-dark-dimmed")!;
const LIGHT = THEMES.find((theme) => theme.id === "github-light-default")!;

describe("cursorLineHighlightBg", () => {
  test("marks context rows on transparent surfaces", () => {
    for (const base of [DARK, LIGHT]) {
      const theme = withTransparentSurfaces(base);
      const context = stackCellPalette("context", theme);

      expect(context.contentBg).toBe(TRANSPARENT_BACKGROUND);
      expect(cursorLineHighlightBg(context.contentBg, theme)).not.toBe(TRANSPARENT_BACKGROUND);
    }
  });

  test("keeps the marked row readable on every built-in theme", () => {
    for (const base of THEMES) {
      for (const theme of [base, withTransparentSurfaces(base)]) {
        for (const kind of ["context", "addition", "deletion"] as const) {
          const marked = cursorLineHighlightBg(stackCellPalette(kind, theme).contentBg, theme);
          expect(contrastRatio(theme.text, marked)).toBeGreaterThan(3);
        }
      }
    }
  });

  test("moves added and removed rows as far as it moves context rows", () => {
    const context = stackCellPalette("context", DARK).contentBg;
    const added = stackCellPalette("addition", DARK).contentBg;

    const shift = (from: string) => {
      const to = cursorLineHighlightBg(from, DARK);
      return contrastRatio(to, from);
    };

    expect(shift(added)).toBeGreaterThan(1.2);
    expect(shift(context)).toBeGreaterThan(1.2);
  });
});

describe("difftastic cell styling", () => {
  test("changed rows keep the normal row background instead of the add/del tint", () => {
    for (const kind of ["addition", "deletion"] as const) {
      for (const palette of [
        splitCellPalette(kind, DARK, undefined, true),
        stackCellPalette(kind, DARK, undefined, true),
      ]) {
        expect(palette.contentBg).toBe(DARK.contextBg);
        expect(palette.gutterBg).toBe(DARK.lineNumberBg);
        expect(palette.numberColor).toBe(DARK.lineNumberFg);
      }
    }
  });

  test("pierre palettes are unchanged without the difftastic flag", () => {
    expect(splitCellPalette("addition", DARK).contentBg).toBe(DARK.addedBg);
    expect(splitCellPalette("deletion", DARK).contentBg).toBe(DARK.removedBg);
    expect(stackCellPalette("addition", DARK).contentBg).toBe(DARK.addedBg);
    expect(stackCellPalette("deletion", DARK).contentBg).toBe(DARK.removedBg);
  });

  test("split gutters render a right-aligned dot for the absent side and no sign", () => {
    const difftEmpty: SplitLineCell = {
      kind: "empty",
      sign: " ",
      difftasticStyle: true,
      spans: [],
    };
    const difftAddition: SplitLineCell = {
      kind: "addition",
      sign: " ",
      lineNumber: 7,
      difftasticStyle: true,
      spans: [],
    };
    const pierreEmpty: SplitLineCell = { kind: "empty", sign: " ", spans: [] };
    const pierreAddition: SplitLineCell = { kind: "addition", sign: "+", lineNumber: 7, spans: [] };

    expect(splitGutterText(difftEmpty, 3, true)).toBe("  .  ");
    expect(splitGutterText(difftAddition, 3, true)).toBe("  7  ");
    // Pierre behavior pinned: blank absent gutter, sign markers kept.
    expect(splitGutterText(pierreEmpty, 3, true)).toBe("     ");
    expect(splitGutterText(pierreAddition, 3, true)).toBe("  7 +");
  });

  test("stack gutters render the dot in whichever number column is absent", () => {
    const difftAddition: StackLineCell = {
      kind: "addition",
      sign: " ",
      newLineNumber: 7,
      difftasticStyle: true,
      spans: [],
    };
    const difftDeletion: StackLineCell = {
      kind: "deletion",
      sign: " ",
      oldLineNumber: 3,
      difftasticStyle: true,
      spans: [],
    };
    const pierreAddition: StackLineCell = {
      kind: "addition",
      sign: "+",
      newLineNumber: 7,
      spans: [],
    };

    expect(stackGutterText(difftAddition, 3, true)).toBe("  .   7  ");
    expect(stackGutterText(difftDeletion, 3, true)).toBe("  3   .  ");
    // Pierre behavior pinned: blank absent column, sign marker kept.
    expect(stackGutterText(pierreAddition, 3, true)).toBe("      7 +");
  });
});
