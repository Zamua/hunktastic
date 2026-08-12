import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDifftasticMapFallback, mapDifftasticFile, type DifftasticMappedFile } from "./map";
import { validateDifftasticFile, type DifftasticFile } from "./schema";

const FIXTURES_DIR = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "test",
  "fixtures",
  "difftastic",
);

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

/** Validate a raw payload so synthetic cases exercise the same typed input as real ones. */
function difftasticFile(raw: unknown): DifftasticFile {
  const parsed = validateDifftasticFile(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.file;
}

function mapFixture(jsonName: string, beforeName: string, afterName: string) {
  const json = difftasticFile(JSON.parse(loadFixture(jsonName)));
  const oldText = loadFixture(beforeName);
  const newText = loadFixture(afterName);
  const result = mapDifftasticFile(json, oldText, newText);
  if (isDifftasticMapFallback(result)) {
    throw new Error(`unexpected fallback: ${result.fallback} (${result.detail})`);
  }
  return { result, oldText, newText };
}

/** `count` newline-terminated lines, optionally overriding some line texts. */
function makeText(count: number, overrides: Record<number, string> = {}): string {
  return Array.from({ length: count }, (_, i) => `${overrides[i] ?? `line ${i}`}\n`).join("");
}

/** Identity alignment for equal-length files, including difftastic's phantom EOF row. */
function identityAligned(lineCount: number): [number | null, number | null][] {
  return Array.from({ length: lineCount + 1 }, (_, i) => [i, i] as [number | null, number | null]);
}

function tokenSpan(start: number, end: number) {
  return { start, end, content: "x", highlight: "normal" };
}

/** One chunk entry marking `line` as a modified pair on both sides. */
function pairEntry(line: number) {
  return {
    lhs: { line_number: line, changes: [tokenSpan(0, 4)] },
    rhs: { line_number: line, changes: [tokenSpan(0, 4)] },
  };
}

/** A changed-status payload for equal-length files with pair edits at `changedLines`. */
function pairEditFile(lineCount: number, changedLines: number[]): DifftasticFile {
  return difftasticFile({
    aligned_lines: identityAligned(lineCount),
    chunks: changedLines.map((line) => [pairEntry(line)]),
    language: "Text",
    path: "after.txt",
    status: "changed",
  });
}

/** Old/new texts whose `changedLines` differ; all other lines are shared context. */
function pairEditTexts(lineCount: number, changedLines: number[]) {
  const oldText = makeText(
    lineCount,
    Object.fromEntries(changedLines.map((line) => [line, `old ${line}`])),
  );
  const newText = makeText(
    lineCount,
    Object.fromEntries(changedLines.map((line) => [line, `new ${line}`])),
  );
  return { oldText, newText };
}

function mapPairEdits(lineCount: number, changedLines: number[]): DifftasticMappedFile {
  const { oldText, newText } = pairEditTexts(lineCount, changedLines);
  const result = mapDifftasticFile(pairEditFile(lineCount, changedLines), oldText, newText);
  if (isDifftasticMapFallback(result)) {
    throw new Error(`unexpected fallback: ${result.fallback} (${result.detail})`);
  }
  return result;
}

/** Invariants the render path relies on for every mapped file. */
function expectRenderInvariants(mapped: DifftasticMappedFile) {
  expect(mapped.noveltySpans.deletionLines).toHaveLength(mapped.deletionLines.length);
  expect(mapped.noveltySpans.additionLines).toHaveLength(mapped.additionLines.length);
  for (const hunk of mapped.hunks) {
    let deletions = 0;
    let additions = 0;
    let contextLines = 0;
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        contextLines += block.lines;
        expect(block.deletionLineIndex + block.lines).toBeLessThanOrEqual(
          mapped.deletionLines.length,
        );
        expect(block.additionLineIndex + block.lines).toBeLessThanOrEqual(
          mapped.additionLines.length,
        );
      } else {
        deletions += block.deletions;
        additions += block.additions;
        expect(block.deletionLineIndex + block.deletions).toBeLessThanOrEqual(
          mapped.deletionLines.length,
        );
        expect(block.additionLineIndex + block.additions).toBeLessThanOrEqual(
          mapped.additionLines.length,
        );
      }
    }
    expect(hunk.deletionLines).toBe(deletions);
    expect(hunk.additionLines).toBe(additions);
    expect(hunk.deletionCount).toBe(contextLines + deletions);
    expect(hunk.additionCount).toBe(contextLines + additions);
  }
}

describe("mapDifftasticFile on the captured sample", () => {
  test("maps to the exact Pierre hunk", () => {
    const { result } = mapFixture("sample-0.69.0.json", "before.js", "after.js");
    expect(result.changeType).toBe("change");
    expect(result.hunks).toEqual([
      {
        collapsedBefore: 0,
        additionStart: 1,
        additionCount: 11,
        additionLines: 6,
        additionLineIndex: 0,
        deletionStart: 1,
        deletionCount: 7,
        deletionLines: 2,
        deletionLineIndex: 0,
        hunkContent: [
          {
            type: "change",
            deletions: 2,
            deletionLineIndex: 0,
            additions: 2,
            additionLineIndex: 0,
          },
          { type: "context", lines: 5, additionLineIndex: 2, deletionLineIndex: 2 },
          {
            type: "change",
            deletions: 0,
            deletionLineIndex: 7,
            additions: 4,
            additionLineIndex: 7,
          },
        ],
        splitLineStart: 0,
        splitLineCount: 11,
        unifiedLineStart: 0,
        unifiedLineCount: 13,
        noEOFCRDeletions: false,
        noEOFCRAdditions: false,
      },
    ]);
    expectRenderInvariants(result);
  });

  test("emits the full file bodies in Pierre isPartial:false convention", () => {
    const { result, oldText, newText } = mapFixture("sample-0.69.0.json", "before.js", "after.js");
    expect(result.deletionLines).toHaveLength(7);
    expect(result.additionLines).toHaveLength(11);
    expect(result.deletionLines.join("")).toBe(oldText);
    expect(result.additionLines.join("")).toBe(newText);
  });

  test("trap: an added blank line with no chunk entry is still an addition with [] spans", () => {
    const { result } = mapFixture("sample-0.69.0.json", "before.js", "after.js");
    // rhs line 7 appears only in aligned_lines as [null, 7].
    expect(result.noveltySpans.additionLines[7]).toEqual([]);
    // It is part of the trailing 4-line addition run starting at index 7.
    const lastBlock = result.hunks[0]?.hunkContent[2];
    expect(lastBlock).toEqual({
      type: "change",
      deletions: 0,
      deletionLineIndex: 7,
      additions: 4,
      additionLineIndex: 7,
    });
  });

  test("trap: an empty-changes side of a modified pair is novel with [] spans", () => {
    const { result } = mapFixture("sample-0.69.0.json", "before.js", "after.js");
    // lhs line 0 has a chunk entry with changes: [] paired with a novel rhs.
    expect(result.noveltySpans.deletionLines[0]).toEqual([]);
    expect(result.noveltySpans.additionLines[0]).toEqual([
      [19, 20],
      [21, 26],
    ]);
  });

  test("novelty spans are 0-based end-exclusive code-unit columns (identity remap on ASCII)", () => {
    const { result, oldText } = mapFixture("sample-0.69.0.json", "before.js", "after.js");
    expect(result.noveltySpans.deletionLines[1]).toEqual([
      [9, 14],
      [15, 16],
      [17, 21],
    ]);
    const oldLine1 = oldText.split("\n")[1] ?? "";
    expect(oldLine1.slice(9, 14)).toBe('"hi "');
    // Context lines carry no entry at all.
    expect(result.noveltySpans.deletionLines[2]).toBeUndefined();
    expect(result.noveltySpans.additionLines[2]).toBeUndefined();
  });
});

describe("mapDifftasticFile on the deleted-lines fixture", () => {
  test("maps unpaired lhs rows to a pure-deletion change block", () => {
    const { result } = mapFixture(
      "deleted-lines-0.69.0.json",
      "deleted-lines-before.js",
      "deleted-lines-after.js",
    );
    expect(result.hunks).toEqual([
      {
        collapsedBefore: 0,
        additionStart: 1,
        additionCount: 4,
        additionLines: 0,
        additionLineIndex: 0,
        deletionStart: 1,
        deletionCount: 6,
        deletionLines: 2,
        deletionLineIndex: 0,
        hunkContent: [
          { type: "context", lines: 2, additionLineIndex: 0, deletionLineIndex: 0 },
          {
            type: "change",
            deletions: 2,
            deletionLineIndex: 2,
            additions: 0,
            additionLineIndex: 2,
          },
          { type: "context", lines: 2, additionLineIndex: 2, deletionLineIndex: 4 },
        ],
        splitLineStart: 0,
        splitLineCount: 6,
        unifiedLineStart: 0,
        unifiedLineCount: 6,
        noEOFCRDeletions: false,
        noEOFCRAdditions: false,
      },
    ]);
    expect(result.noveltySpans.deletionLines[2]).toHaveLength(7);
    expect(result.noveltySpans.deletionLines[3]).toHaveLength(7);
    expect(result.noveltySpans.additionLines.every((entry) => entry === undefined)).toBe(true);
    expectRenderInvariants(result);
  });
});

describe("mapDifftasticFile on the tabs fixture", () => {
  test("tab bytes are single-byte, so remapped columns equal string indexes", () => {
    const { result } = mapFixture("tabs-0.69.0.json", "tabs-before.js", "tabs-after.js");
    expectRenderInvariants(result);
    const spans = result.noveltySpans.additionLines[1] ?? [];
    expect(spans).toContainEqual([25, 30]);
    // The line starts with a real tab; a 1-byte tab keeps offsets aligned.
    const line = result.additionLines[1] ?? "";
    expect(line.startsWith("\t")).toBe(true);
    expect(line.slice(25, 30)).toBe("slice");
  });

  test("pair rows plus trailing context map to one context-merged hunk", () => {
    const { result } = mapFixture("tabs-0.69.0.json", "tabs-before.js", "tabs-after.js");
    expect(result.hunks).toEqual([
      {
        collapsedBefore: 0,
        additionStart: 1,
        additionCount: 5,
        additionLines: 2,
        additionLineIndex: 0,
        deletionStart: 1,
        deletionCount: 5,
        deletionLines: 2,
        deletionLineIndex: 0,
        hunkContent: [
          {
            type: "change",
            deletions: 2,
            deletionLineIndex: 0,
            additions: 2,
            additionLineIndex: 0,
          },
          { type: "context", lines: 3, additionLineIndex: 2, deletionLineIndex: 2 },
        ],
        splitLineStart: 0,
        splitLineCount: 5,
        unifiedLineStart: 0,
        unifiedLineCount: 7,
        noEOFCRDeletions: false,
        noEOFCRAdditions: false,
      },
    ]);
  });
});

describe("mapDifftasticFile on the unicode fixture", () => {
  test("remaps UTF-8 byte columns to code-unit columns on both sides", () => {
    const { result } = mapFixture("unicode-0.69.0.json", "unicode-before.js", "unicode-after.js");
    expectRenderInvariants(result);
    // The fixture reports the token at byte columns [35,38]; the mapper must
    // land it on the code-unit slice after the 3-byte Japanese characters.
    const raw = JSON.parse(loadFixture("unicode-0.69.0.json"));
    expect(raw.chunks[0][0].rhs.changes[0]).toMatchObject({ start: 35, end: 38 });
    expect(result.noveltySpans.additionLines[1]).toEqual([[21, 24]]);
    expect((result.additionLines[1] ?? "").slice(21, 24)).toBe("neo");
    expect(result.noveltySpans.deletionLines[1]).toEqual([[21, 24]]);
    expect((result.deletionLines[1] ?? "").slice(21, 24)).toBe("old");
  });
});

describe("byte-offset span validation", () => {
  /** One-pair payload whose lhs carries a single change span over "日x". */
  function mapWithLhsSpan(span: { start: number; end: number }) {
    return mapDifftasticFile(
      difftasticFile({
        aligned_lines: [
          [0, 0],
          [1, 1],
        ],
        chunks: [
          [
            {
              lhs: { line_number: 0, changes: [{ ...span, content: "x", highlight: "normal" }] },
              rhs: { line_number: 0, changes: [] },
            },
          ],
        ],
        language: "Text",
        path: "a.txt",
        status: "changed",
      }),
      "日x\n",
      "日y\n",
    );
  }

  test("a span on code-point boundaries remaps across a multibyte prefix", () => {
    // "日" is bytes [0,3); "x" is byte 3 = code unit 1.
    const result = mapWithLhsSpan({ start: 3, end: 4 });
    if (isDifftasticMapFallback(result)) throw new Error("expected a mapped result");
    expect(result.noveltySpans.deletionLines[0]).toEqual([[1, 2]]);
  });

  test.each<[string, { start: number; end: number }]>([
    ["a start inside a code point", { start: 1, end: 4 }],
    ["an end past the line's bytes", { start: 0, end: 99 }],
  ])("%s falls back", (_name, span) => {
    const result = mapWithLhsSpan(span);
    expect(isDifftasticMapFallback(result)).toBe(true);
    if (!isDifftasticMapFallback(result)) return;
    expect(result.fallback).toBe("invalid-span");
  });
});

describe("mixed change runs", () => {
  test("adjacent del/pair/add rows emit three adjacent ChangeContent blocks", () => {
    const oldText = ["shared 0", "deleted 1", "old pair", "shared 3", "shared 4"]
      .map((line) => `${line}\n`)
      .join("");
    const newText = ["shared 0", "new pair", "added 2", "shared 3", "shared 4"]
      .map((line) => `${line}\n`)
      .join("");
    const result = mapDifftasticFile(
      difftasticFile({
        aligned_lines: [
          [0, 0],
          [1, null],
          [2, 1],
          [null, 2],
          [3, 3],
          [4, 4],
          [5, 5],
        ],
        chunks: [
          [
            {
              lhs: { line_number: 2, changes: [tokenSpan(0, 3)] },
              rhs: { line_number: 1, changes: [tokenSpan(0, 3)] },
            },
          ],
        ],
        language: "Text",
        path: "after.txt",
        status: "changed",
      }),
      oldText,
      newText,
    );
    if (isDifftasticMapFallback(result)) {
      throw new Error(`unexpected fallback: ${result.fallback} (${result.detail})`);
    }
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]?.hunkContent).toEqual([
      { type: "context", lines: 1, additionLineIndex: 0, deletionLineIndex: 0 },
      { type: "change", deletions: 1, deletionLineIndex: 1, additions: 0, additionLineIndex: 1 },
      { type: "change", deletions: 1, deletionLineIndex: 2, additions: 1, additionLineIndex: 1 },
      { type: "change", deletions: 0, deletionLineIndex: 3, additions: 1, additionLineIndex: 2 },
      { type: "context", lines: 2, additionLineIndex: 3, deletionLineIndex: 3 },
    ]);
    expect(result.hunks[0]?.deletionLines).toBe(2);
    expect(result.hunks[0]?.additionLines).toBe(2);
    expect(result.noveltySpans.deletionLines[1]).toEqual([]);
    expect(result.noveltySpans.deletionLines[2]).toEqual([[0, 3]]);
    expect(result.noveltySpans.additionLines[1]).toEqual([[0, 3]]);
    expect(result.noveltySpans.additionLines[2]).toEqual([]);
    expectRenderInvariants(result);
  });
});

describe("hunk boundaries", () => {
  test("chunks whose context windows touch merge into one hunk", () => {
    const result = mapPairEdits(20, [2, 9]);
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]?.hunkContent).toEqual([
      { type: "context", lines: 2, additionLineIndex: 0, deletionLineIndex: 0 },
      { type: "change", deletions: 1, deletionLineIndex: 2, additions: 1, additionLineIndex: 2 },
      { type: "context", lines: 6, additionLineIndex: 3, deletionLineIndex: 3 },
      { type: "change", deletions: 1, deletionLineIndex: 9, additions: 1, additionLineIndex: 9 },
      { type: "context", lines: 3, additionLineIndex: 10, deletionLineIndex: 10 },
    ]);
    expectRenderInvariants(result);
  });

  test("far-apart chunks stay separate hunks with correct collapsedBefore", () => {
    const result = mapPairEdits(20, [2, 15]);
    expect(result.hunks).toEqual([
      {
        collapsedBefore: 0,
        additionStart: 1,
        additionCount: 6,
        additionLines: 1,
        additionLineIndex: 0,
        deletionStart: 1,
        deletionCount: 6,
        deletionLines: 1,
        deletionLineIndex: 0,
        hunkContent: [
          { type: "context", lines: 2, additionLineIndex: 0, deletionLineIndex: 0 },
          {
            type: "change",
            deletions: 1,
            deletionLineIndex: 2,
            additions: 1,
            additionLineIndex: 2,
          },
          { type: "context", lines: 3, additionLineIndex: 3, deletionLineIndex: 3 },
        ],
        splitLineStart: 0,
        splitLineCount: 6,
        unifiedLineStart: 0,
        unifiedLineCount: 7,
        noEOFCRDeletions: false,
        noEOFCRAdditions: false,
      },
      {
        collapsedBefore: 6,
        additionStart: 13,
        additionCount: 7,
        additionLines: 1,
        additionLineIndex: 12,
        deletionStart: 13,
        deletionCount: 7,
        deletionLines: 1,
        deletionLineIndex: 12,
        hunkContent: [
          { type: "context", lines: 3, additionLineIndex: 12, deletionLineIndex: 12 },
          {
            type: "change",
            deletions: 1,
            deletionLineIndex: 15,
            additions: 1,
            additionLineIndex: 15,
          },
          { type: "context", lines: 3, additionLineIndex: 16, deletionLineIndex: 16 },
        ],
        splitLineStart: 12,
        splitLineCount: 7,
        unifiedLineStart: 13,
        unifiedLineCount: 8,
        noEOFCRDeletions: false,
        noEOFCRAdditions: false,
      },
    ]);
    expectRenderInvariants(result);
  });

  test("a first hunk deep in the file counts the leading collapsed rows", () => {
    const result = mapPairEdits(20, [10]);
    const hunk = result.hunks[0];
    expect(result.hunks).toHaveLength(1);
    expect(hunk?.collapsedBefore).toBe(7);
    expect(hunk?.deletionStart).toBe(8);
    expect(hunk?.additionStart).toBe(8);
    expect(hunk?.splitLineStart).toBe(7);
    expect(hunk?.unifiedLineStart).toBe(7);
  });
});

describe("status handling", () => {
  const oldText = makeText(3);
  const newText = makeText(3);

  test("unchanged maps to empty hunks with full bodies", () => {
    const result = mapDifftasticFile(
      difftasticFile({ language: "Text", path: "a.txt", status: "unchanged" }),
      oldText,
      newText,
    );
    if (isDifftasticMapFallback(result)) throw new Error("expected a mapped result");
    expect(result.hunks).toEqual([]);
    expect(result.deletionLines).toHaveLength(3);
    expect(result.additionLines).toHaveLength(3);
    expect(result.noveltySpans.deletionLines.every((entry) => entry === undefined)).toBe(true);
    expect(result.noveltySpans.additionLines.every((entry) => entry === undefined)).toBe(true);
    expect(result.changeType).toBe("change");
  });

  test("the baseline change type is preserved", () => {
    const result = mapDifftasticFile(
      difftasticFile({ language: "Text", path: "a.txt", status: "unchanged" }),
      oldText,
      newText,
      { changeType: "rename-changed" },
    );
    if (isDifftasticMapFallback(result)) throw new Error("expected a mapped result");
    expect(result.changeType).toBe("rename-changed");
  });

  test.each(["created", "deleted", "binary", "mystery"])("status %s falls back", (status) => {
    const result = mapDifftasticFile(
      difftasticFile({ language: "Text", path: "a.txt", status }),
      oldText,
      newText,
    );
    expect(isDifftasticMapFallback(result)).toBe(true);
    if (!isDifftasticMapFallback(result)) return;
    expect(result.fallback).toBe("unsupported-status");
  });

  test("changed without aligned_lines falls back", () => {
    const result = mapDifftasticFile(
      difftasticFile({ language: "Text", path: "a.txt", status: "changed" }),
      oldText,
      newText,
    );
    expect(isDifftasticMapFallback(result)).toBe(true);
    if (!isDifftasticMapFallback(result)) return;
    expect(result.fallback).toBe("missing-alignment");
  });
});

describe("defensive validation", () => {
  const oldText = makeText(2);
  const newText = makeText(2);

  function mapAligned(aligned: [number | null, number | null][]) {
    return mapDifftasticFile(
      difftasticFile({
        aligned_lines: aligned,
        chunks: [],
        language: "Text",
        path: "a.txt",
        status: "changed",
      }),
      oldText,
      newText,
    );
  }

  test.each<[string, [number | null, number | null][]]>([
    [
      "non-monotonic rows",
      [
        [1, 1],
        [0, 0],
        [2, 2],
      ],
    ],
    [
      "duplicated line",
      [
        [0, 0],
        [0, 1],
        [1, 2],
      ],
    ],
    ["incomplete coverage", [[0, 0]]],
    [
      "out-of-bounds line",
      [
        [0, 0],
        [1, 1],
        [5, 2],
      ],
    ],
    [
      "both sides null",
      [
        [0, 0],
        [null, null],
        [1, 1],
      ],
    ],
  ])("%s falls back without throwing", (_name, aligned) => {
    const result = mapAligned(aligned);
    expect(isDifftasticMapFallback(result)).toBe(true);
    if (!isDifftasticMapFallback(result)) return;
    expect(result.fallback).toBe("invalid-alignment");
  });

  test("a phantom EOF line paired with a real line falls back", () => {
    // Old has 2 real lines (phantom index 2); new has 1 (phantom index 1).
    // Row [1, 1] pairs a real old line with the new side's phantom.
    const result = mapDifftasticFile(
      difftasticFile({
        aligned_lines: [
          [0, 0],
          [1, 1],
          [2, null],
        ],
        chunks: [],
        language: "Text",
        path: "a.txt",
        status: "changed",
      }),
      makeText(2),
      makeText(1),
    );
    expect(isDifftasticMapFallback(result)).toBe(true);
    if (!isDifftasticMapFallback(result)) return;
    expect(result.fallback).toBe("invalid-alignment");
  });

  test("a chunk line number beyond the file falls back", () => {
    const result = mapDifftasticFile(
      difftasticFile({
        aligned_lines: identityAligned(2),
        chunks: [[{ lhs: { line_number: 99, changes: [tokenSpan(0, 1)] } }]],
        language: "Text",
        path: "a.txt",
        status: "changed",
      }),
      oldText,
      newText,
    );
    expect(isDifftasticMapFallback(result)).toBe(true);
    if (!isDifftasticMapFallback(result)) return;
    expect(result.fallback).toBe("chunk-out-of-bounds");
  });

  test("a context row whose texts differ falls back (a chunk the schema missed)", () => {
    const result = mapDifftasticFile(
      difftasticFile({
        aligned_lines: identityAligned(2),
        chunks: [],
        language: "Text",
        path: "a.txt",
        status: "changed",
      }),
      makeText(2, { 1: "only in old" }),
      makeText(2),
    );
    expect(isDifftasticMapFallback(result)).toBe(true);
    if (!isDifftasticMapFallback(result)) return;
    expect(result.fallback).toBe("context-mismatch");
  });

  test("a chunk entry with empty changes on both sides classifies as context", () => {
    const result = mapDifftasticFile(
      difftasticFile({
        aligned_lines: identityAligned(3),
        chunks: [
          [
            {
              lhs: { line_number: 1, changes: [] },
              rhs: { line_number: 1, changes: [] },
            },
          ],
        ],
        language: "Text",
        path: "a.txt",
        status: "changed",
      }),
      makeText(3),
      makeText(3),
    );
    if (isDifftasticMapFallback(result)) throw new Error("expected a mapped result");
    // The row is context, so no line is novel; the chunk still anchors a hunk span.
    expect(result.noveltySpans.deletionLines[1]).toBeUndefined();
    expect(result.noveltySpans.additionLines[1]).toBeUndefined();
    expect(result.hunks[0]?.deletionLines).toBe(0);
    expect(result.hunks[0]?.additionLines).toBe(0);
    expectRenderInvariants(result);
  });
});

describe("EOF newline flags", () => {
  test("a hunk reaching the end of a newline-less side sets the flag", () => {
    // Old ends without a newline; the single change touches the last line.
    const oldText = "shared\nold tail";
    const newText = "shared\nnew tail";
    const result = mapDifftasticFile(
      difftasticFile({
        aligned_lines: [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
        chunks: [[pairEntry(1)]],
        language: "Text",
        path: "a.txt",
        status: "changed",
      }),
      oldText,
      newText,
    );
    if (isDifftasticMapFallback(result)) throw new Error("expected a mapped result");
    expect(result.hunks[0]?.noEOFCRDeletions).toBe(true);
    expect(result.hunks[0]?.noEOFCRAdditions).toBe(true);
    expectRenderInvariants(result);
  });
});
