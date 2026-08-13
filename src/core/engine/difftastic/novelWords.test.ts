import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { classifyNovelWords, isWordSplitScope, splitWordsAndNumbers } from "./novelWords";
import { validateDifftasticFile, type DifftasticChangeSpan } from "./schema";
import type { ColumnSpan } from "../../types";

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

/** difftastic reports UTF-8 byte columns; read one back in that space. */
function sliceBytes(line: string, start: number, end: number): string {
  return Buffer.from(line, "utf8").subarray(start, end).toString("utf8");
}

interface FixtureAtom {
  /** Atom text as difftastic diffed it, delimiters included. */
  content: string;
  /** Byte column the atom starts at within its line. */
  byteStart: number;
  spans: DifftasticChangeSpan[];
}

/**
 * The atom behind one side of a fixture's first chunk entry, reconstructed from
 * the real difft payload the way a consumer has to: the spans of a line span the
 * atom, so the source text between the first and last one is its content. That
 * holds for these fixtures because every atom opens and closes on a token
 * difftastic emits.
 */
function readAtom(name: string, side: "lhs" | "rhs"): FixtureAtom {
  const parsed = validateDifftasticFile(JSON.parse(loadFixture(`${name}-0.69.0.json`)));
  if (!parsed.ok) throw new Error(parsed.error.message);
  const entry = parsed.file.chunks?.[0]?.[0]?.[side];
  if (entry == null) throw new Error(`fixture ${name} has no ${side} entry`);
  const sourceName = side === "lhs" ? `${name}-before.js` : `${name}-after.js`;
  const line = loadFixture(sourceName).split("\n")[entry.line_number];
  if (line == null) throw new Error(`fixture ${name} has no ${side} line ${entry.line_number}`);
  const spans = entry.changes;
  const first = spans[0];
  const last = spans[spans.length - 1];
  if (first == null || last == null) throw new Error(`fixture ${name} ${side} has no spans`);
  return { content: sliceBytes(line, first.start, last.end), byteStart: first.start, spans };
}

function readAtomPair(name: string): { lhs: FixtureAtom; rhs: FixtureAtom } {
  return { lhs: readAtom(name, "lhs"), rhs: readAtom(name, "rhs") };
}

/** Re-express a content-relative code-unit range as the line-relative byte range difft prints. */
function toLineByteRange(atom: FixtureAtom, [start, end]: ColumnSpan): [number, number] {
  const prefix = Buffer.byteLength(atom.content.slice(0, start), "utf8");
  const width = Buffer.byteLength(atom.content.slice(start, end), "utf8");
  return [atom.byteStart + prefix, atom.byteStart + prefix + width];
}

/** Text of a returned range, so an assertion names the word rather than two numbers. */
function rangeTexts(atom: FixtureAtom, ranges: ColumnSpan[]): string[] {
  return ranges.map(([start, end]) => atom.content.slice(start, end));
}

describe("splitWordsAndNumbers", () => {
  // Ported from difftastic's own `src/words.rs` tests.
  test("splits words from single non-word characters", () => {
    expect(splitWordsAndNumbers("example.com")).toEqual(["example", ".", "com"]);
    expect(splitWordsAndNumbers("example..")).toEqual(["example", ".", "."]);
    expect(splitWordsAndNumbers("example.\ncom")).toEqual(["example", ".", "\n", "com"]);
    expect(splitWordsAndNumbers("foo bar")).toEqual(["foo", " ", "bar"]);
  });

  test("splits at every ascii digit boundary", () => {
    expect(splitWordsAndNumbers("a123b")).toEqual(["a", "123", "b"]);
    expect(splitWordsAndNumbers("foo..bar23")).toEqual(["foo", ".", ".", "bar", "23"]);
    expect(splitWordsAndNumbers("12ab34")).toEqual(["12", "ab", "34"]);
  });

  test("keeps underscores inside words", () => {
    expect(splitWordsAndNumbers("user_name_first")).toEqual(["user_name_first"]);
  });

  test("treats alphanumeric code points as word characters and others as single tokens", () => {
    expect(splitWordsAndNumbers("a xöy b")).toEqual(["a", " ", "xöy", " ", "b"]);
    // Rust `is_alphanumeric` covers Nl and No, so roman numerals and vulgar
    // fractions join a word; an emoji is not alphanumeric.
    expect(splitWordsAndNumbers("aⅫ½")).toEqual(["aⅫ½"]);
    expect(splitWordsAndNumbers("a 💝 b")).toEqual(["a", " ", "💝", " ", "b"]);
  });

  test("iterates by code point so an astral character stays one token", () => {
    const tokens = splitWordsAndNumbers('"日本語 💝"');
    expect(tokens).toEqual(['"', "日本語", " ", "💝", '"']);
    expect(tokens.join("")).toBe('"日本語 💝"');
  });
});

describe("isWordSplitScope", () => {
  test("accepts matching comment and string atoms", () => {
    expect(isWordSplitScope("comment", "comment")).toBe(true);
    expect(isWordSplitScope("string", "string")).toBe(true);
  });

  test("rejects every other highlight kind and mismatched sides", () => {
    for (const kind of ["normal", "keyword", "type", "delimiter", "tree_sitter_error"]) {
      expect(isWordSplitScope(kind, kind)).toBe(false);
    }
    expect(isWordSplitScope("string", "comment")).toBe(false);
    expect(isWordSplitScope("comment", "normal")).toBe(false);
  });
});

describe("classifyNovelWords against real difft payloads", () => {
  test("marks the one changed word inside a string literal", () => {
    const { lhs, rhs } = readAtomPair("novel-string");
    expect(lhs.content).toBe('"the quick brown fox jumps over the lazy dog"');
    expect(isWordSplitScope(lhs.spans[0]!.highlight, rhs.spans[0]!.highlight)).toBe(true);

    const ranges = classifyNovelWords(lhs.content, rhs.content);
    expect(ranges).not.toBeNull();
    expect(ranges!.lhs).toEqual([[17, 20]]);
    expect(ranges!.rhs).toEqual([[17, 20]]);
    expect(rangeTexts(lhs, ranges!.lhs)).toEqual(["fox"]);
    expect(rangeTexts(rhs, ranges!.rhs)).toEqual(["cat"]);
  });

  test("marks the one changed word inside a comment", () => {
    const { lhs, rhs } = readAtomPair("novel-comment");
    expect(lhs.content).toBe("// Retry the request when the server returns a transient error.");
    expect(isWordSplitScope(lhs.spans[0]!.highlight, rhs.spans[0]!.highlight)).toBe(true);

    const ranges = classifyNovelWords(lhs.content, rhs.content);
    expect(ranges).not.toBeNull();
    // The changed words end at different columns because they differ in length.
    expect(ranges!.lhs).toEqual([[57, 62]]);
    expect(ranges!.rhs).toEqual([[57, 64]]);
    expect(rangeTexts(lhs, ranges!.lhs)).toEqual(["error"]);
    expect(rangeTexts(rhs, ranges!.rhs)).toEqual(["failure"]);
  });

  test("counts a changed word in code units, not bytes, after multibyte text", () => {
    const { lhs, rhs } = readAtomPair("novel-multibyte");
    expect(lhs.content).toBe('"日本語 the quick brown fox jumps"');

    const ranges = classifyNovelWords(lhs.content, rhs.content);
    expect(ranges).not.toBeNull();
    expect(ranges!.lhs).toEqual([[21, 24]]);
    expect(rangeTexts(lhs, ranges!.lhs)).toEqual(["fox"]);
    // The same word sits at byte column 40 in the line, which is what difft prints.
    expect(toLineByteRange(lhs, ranges!.lhs[0]!)).toEqual([40, 43]);
    expect(rangeTexts(rhs, ranges!.rhs)).toEqual(["cat"]);
  });

  test("the similarity gate rejects a string where almost everything changed", () => {
    const { lhs, rhs } = readAtomPair("novel-dissimilar");
    expect(lhs.content).toBe('"alpha beta"');
    expect(rhs.content).toBe('"gamma delta"');
    // Ground truth: difft emitted one whole-atom span per side, no inner words.
    expect(lhs.spans).toHaveLength(1);
    expect(rhs.spans).toHaveLength(1);

    expect(classifyNovelWords(lhs.content, rhs.content)).toBeNull();
  });

  test("a changed identifier is out of scope and gets no inner emphasis", () => {
    const { lhs, rhs } = readAtomPair("novel-identifier");
    expect(lhs.content).toBe("computeSum");
    expect(rhs.content).toBe("computeAverage");
    // Ground truth: difft emitted one whole-atom span per side, highlighted as a
    // plain atom rather than a comment or string.
    expect(lhs.spans).toHaveLength(1);
    expect(rhs.spans).toHaveLength(1);
    expect(lhs.spans[0]!.highlight).toBe("normal");

    expect(isWordSplitScope(lhs.spans[0]!.highlight, rhs.spans[0]!.highlight)).toBe(false);
  });

  test("a whitespace-only changed token is skipped rather than emphasised", () => {
    const { lhs, rhs } = readAtomPair("novel-whitespace");
    expect(lhs.content).toBe('"alpha beta gamma delta"');
    expect(rhs.content).toBe('"alpha beta  gamma delta"');
    // Ground truth: difft left a one-byte hole at the added space, so it emitted
    // no position for that token at all.
    const rhsStarts = rhs.spans.map((span) => span.start);
    const rhsEnds = rhs.spans.map((span) => span.end);
    expect(rhsEnds.slice(0, -1).some((end, index) => end !== rhsStarts[index + 1])).toBe(true);

    const ranges = classifyNovelWords(lhs.content, rhs.content);
    expect(ranges).not.toBeNull();
    expect(ranges!.lhs).toEqual([]);
    expect(ranges!.rhs).toEqual([]);
  });

  test("every reported range is verbatim one of difft's own spans", () => {
    for (const name of ["novel-string", "novel-comment", "novel-multibyte"]) {
      const { lhs, rhs } = readAtomPair(name);
      const ranges = classifyNovelWords(lhs.content, rhs.content);
      expect(ranges).not.toBeNull();
      for (const [atom, sideRanges] of [
        [lhs, ranges!.lhs],
        [rhs, ranges!.rhs],
      ] as const) {
        expect(sideRanges.length).toBeGreaterThan(0);
        for (const range of sideRanges) {
          const [start, end] = toLineByteRange(atom, range);
          const match = atom.spans.find((span) => span.start === start && span.end === end);
          expect(`${name}: ${start}-${end} ${match?.content}`).toBe(
            `${name}: ${start}-${end} ${atom.content.slice(range[0], range[1])}`,
          );
        }
      }
    }
  });
});

describe("classifyNovelWords similarity gate", () => {
  test("needs more than two unchanged non-space tokens", () => {
    expect(classifyNovelWords("a b c d", "a b c e")).toEqual({ lhs: [[6, 7]], rhs: [[6, 7]] });
    expect(classifyNovelWords("a b d", "a b e")).toBeNull();
  });

  test("needs unchanged tokens to cover at least half the novel ones", () => {
    expect(classifyNovelWords("a b c p q r", "a b c x y z")).not.toBeNull();
    expect(classifyNovelWords("a b c p q r s", "a b c x y z w")).toBeNull();
  });

  test("a single space never counts toward the unchanged total", () => {
    // Three shared words pass; dropping one to two spaces plus two words fails.
    expect(classifyNovelWords("aa bb cc dd", "aa bb cc ee")).not.toBeNull();
    expect(classifyNovelWords("aa bb dd", "aa bb ee")).toBeNull();
  });

  test("reports one range per changed token without merging adjacent ones", () => {
    const ranges = classifyNovelWords("aa bb cc dd ee", "aa bb cc xx yy");
    expect(ranges).not.toBeNull();
    // "dd" and "ee" are separate changed tokens with the untouched space between.
    expect(ranges!.lhs).toEqual([
      [9, 11],
      [12, 14],
    ]);
    expect(ranges!.rhs).toEqual([
      [9, 11],
      [12, 14],
    ]);
  });
});
