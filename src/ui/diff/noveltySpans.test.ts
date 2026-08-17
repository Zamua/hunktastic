import { describe, expect, test } from "bun:test";
import type { ColumnSpan } from "../../core/types";
import { overlayNoveltySpans, remapColumnSpansThroughTabs } from "./noveltySpans";
import type { RenderSpan } from "./diffRowModel";

const NOVEL = "#f85149";

/** Concatenate span texts back into the rendered line. */
function joinText(spans: RenderSpan[]) {
  return spans.map((span) => span.text).join("");
}

describe("overlayNoveltySpans", () => {
  test("splits a range inside one span into plain, emphasized, plain", () => {
    const spans: RenderSpan[] = [{ text: "const a = 1;", fg: "#ffffff" }];
    const result = overlayNoveltySpans(spans, [[6, 7]], { fg: NOVEL });

    expect(result).toEqual([
      { text: "const ", fg: "#ffffff" },
      { text: "a", fg: NOVEL },
      { text: " = 1;", fg: "#ffffff" },
    ]);
  });

  test("carries one range across multiple span boundaries preserving per-span colors", () => {
    const spans: RenderSpan[] = [
      { text: "const ", fg: "#111111" },
      { text: "answer", fg: "#222222" },
      { text: " = 41;", fg: "#333333" },
    ];
    const result = overlayNoveltySpans(spans, [[3, 9]], { underline: true });

    expect(result).toEqual([
      { text: "con", fg: "#111111" },
      { text: "st ", fg: "#111111", underline: true },
      { text: "ans", fg: "#222222", underline: true },
      { text: "wer", fg: "#222222" },
      { text: " = 41;", fg: "#333333" },
    ]);
  });

  test("handles ranges landing exactly on span boundaries", () => {
    const spans: RenderSpan[] = [
      { text: "abc", fg: "#111111" },
      { text: "def", fg: "#222222" },
    ];
    const result = overlayNoveltySpans(spans, [[0, 3]], { fg: NOVEL });

    expect(result).toEqual([
      { text: "abc", fg: NOVEL },
      { text: "def", fg: "#222222" },
    ]);
  });

  test("recolors the full line when the range covers every column", () => {
    const spans: RenderSpan[] = [{ text: "abc" }, { text: "def" }];
    const result = overlayNoveltySpans(spans, [[0, 6]], { fg: NOVEL });

    expect(result).toEqual([{ text: "abcdef", fg: NOVEL }]);
  });

  test("returns the input spans unchanged for an empty column list", () => {
    const spans: RenderSpan[] = [{ text: "abc", fg: "#111111" }];

    expect(overlayNoveltySpans(spans, [], { fg: NOVEL })).toBe(spans);
  });

  test("clamps out-of-bounds columns and drops empty or inverted ranges", () => {
    const spans: RenderSpan[] = [{ text: "abcdef" }];

    expect(overlayNoveltySpans(spans, [[4, 99]], { fg: NOVEL })).toEqual([
      { text: "abcd" },
      { text: "ef", fg: NOVEL },
    ]);
    expect(overlayNoveltySpans(spans, [[-5, 2]], { fg: NOVEL })).toEqual([
      { text: "ab", fg: NOVEL },
      { text: "cdef" },
    ]);
    expect(overlayNoveltySpans(spans, [[50, 60]], { fg: NOVEL })).toBe(spans);
    expect(overlayNoveltySpans(spans, [[3, 3]], { fg: NOVEL })).toBe(spans);
    expect(overlayNoveltySpans(spans, [[5, 2]], { fg: NOVEL })).toBe(spans);
  });

  test("merges overlapping and touching ranges into one emphasized run", () => {
    const spans: RenderSpan[] = [{ text: "abcdef", fg: "#111111" }];
    const result = overlayNoveltySpans(
      spans,
      [
        [3, 5],
        [0, 2],
        [2, 4],
      ],
      { fg: NOVEL },
    );

    expect(result).toEqual([
      { text: "abcde", fg: NOVEL },
      { text: "f", fg: "#111111" },
    ]);
  });

  test("never mutates the input spans", () => {
    const spans: RenderSpan[] = [
      Object.freeze({ text: "const ", fg: "#111111" }),
      Object.freeze({ text: "answer;", fg: "#222222" }),
    ];
    Object.freeze(spans);

    const result = overlayNoveltySpans(spans, [[2, 9]], { fg: NOVEL });

    expect(joinText(result)).toBe("const answer;");
    expect(spans[0]).toEqual({ text: "const ", fg: "#111111" });
    expect(spans[1]).toEqual({ text: "answer;", fg: "#222222" });
  });

  test("applies a foreground emphasis while keeping the row background", () => {
    const spans: RenderSpan[] = [
      { text: "const ", fg: "#111111", bg: "#000000" },
      { text: "answer", fg: "#222222", bg: "#000000" },
    ];
    const result = overlayNoveltySpans(spans, [[6, 12]], { fg: NOVEL });

    expect(result).toEqual([
      { text: "const ", fg: "#111111", bg: "#000000" },
      { text: "answer", fg: NOVEL, bg: "#000000" },
    ]);
  });

  test("does not merge a bold emphasis run into an identically colored plain run", () => {
    const spans: RenderSpan[] = [{ text: "abcdef", fg: "#ff0000" }];
    const result = overlayNoveltySpans(spans, [[0, 3]], { bold: true });

    expect(result).toEqual([
      { text: "abc", fg: "#ff0000", bold: true },
      { text: "def", fg: "#ff0000" },
    ]);
  });

  test("an attribute-only emphasis keeps both colors and adds the attributes", () => {
    const spans: RenderSpan[] = [{ text: "alpha beta", fg: "#111111", bg: "#000000" }];
    const result = overlayNoveltySpans(spans, [[6, 10]], { bold: true, underline: true });

    expect(result).toEqual([
      { text: "alpha ", fg: "#111111", bg: "#000000" },
      { text: "beta", fg: "#111111", bg: "#000000", bold: true, underline: true },
    ]);
  });

  test("a second emphasis pass keeps what the first one applied", () => {
    // The changed-word tier layers over the novelty style: colors from pass one,
    // attributes from pass two, on the narrower range.
    const spans: RenderSpan[] = [{ text: "alpha beta", fg: "#111111" }];
    const novel = overlayNoveltySpans(spans, [[0, 10]], { fg: NOVEL });
    const result = overlayNoveltySpans(novel, [[6, 10]], { bold: true, underline: true });

    expect(result).toEqual([
      { text: "alpha ", fg: NOVEL },
      { text: "beta", fg: NOVEL, bold: true, underline: true },
    ]);
  });

  test("does not merge an underlined run into an identically colored plain run", () => {
    const spans: RenderSpan[] = [{ text: "abcdef", fg: "#ff0000" }];
    const result = overlayNoveltySpans(spans, [[0, 3]], { underline: true });

    expect(result).toEqual([
      { text: "abc", fg: "#ff0000", underline: true },
      { text: "def", fg: "#ff0000" },
    ]);
  });

  test("preserves the full line text under arbitrary ranges", () => {
    const spans: RenderSpan[] = [
      { text: "let " },
      { text: "total", fg: "#111111" },
      { text: " += 12;" },
    ];
    const columnSpans: ColumnSpan[] = [
      [1, 2],
      [5, 11],
      [13, 15],
    ];

    expect(joinText(overlayNoveltySpans(spans, columnSpans, { fg: NOVEL }))).toBe(
      "let total += 12;",
    );
  });
});

describe("remapColumnSpansThroughTabs", () => {
  test("returns the same spans for tab-free text", () => {
    const columnSpans: ColumnSpan[] = [[1, 3]];

    expect(remapColumnSpansThroughTabs("no tabs", columnSpans, 4)).toBe(columnSpans);
  });

  test("shifts columns behind tab expansion runs", () => {
    // "\tfoo\tbar" with width 4 renders "    foo bar": foo at 4..7, bar at 8..11.
    expect(remapColumnSpansThroughTabs("\tfoo\tbar", [[1, 4]], 4)).toEqual([[4, 7]]);
    expect(remapColumnSpansThroughTabs("\tfoo\tbar", [[5, 8]], 4)).toEqual([[8, 11]]);
  });

  test("maps a span covering the tab character to its full expansion run", () => {
    expect(remapColumnSpansThroughTabs("\tfoo\tbar", [[0, 1]], 4)).toEqual([[0, 4]]);
    expect(remapColumnSpansThroughTabs("\tfoo\tbar", [[4, 5]], 4)).toEqual([[7, 8]]);
  });

  test("advances tab stops by terminal cells for wide characters", () => {
    // "日" is two cells wide, so the tab expands to two spaces: "日  x".
    expect(remapColumnSpansThroughTabs("日\tx", [[2, 3]], 4)).toEqual([[3, 4]]);
  });

  test("clamps offsets beyond the line to the expanded end", () => {
    expect(remapColumnSpansThroughTabs("\tfoo\tbar", [[5, 99]], 4)).toEqual([[8, 11]]);
  });
});
