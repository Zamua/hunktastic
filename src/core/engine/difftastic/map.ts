import type { ChangeContent, ChangeTypes, ContextContent, Hunk } from "@pierre/diffs";
import type { ColumnSpan, DiffLineNoveltySpans } from "../../types";
import { classifyNovelWords, isWordSplitScope } from "./novelWords";
import type { DifftasticFile } from "./schema";

/**
 * Maps one validated difftastic payload plus both full file bodies onto the
 * Pierre hunk model. Pure and throw-free: any payload the mapper cannot prove
 * consistent with the file bodies becomes a typed fallback result, and the
 * caller keeps the Pierre baseline for that file.
 */

export type DifftasticMapFallbackReason =
  | "missing-alignment"
  | "invalid-alignment"
  | "chunk-out-of-bounds"
  | "context-mismatch"
  | "invalid-span"
  | "unsupported-status";

export interface DifftasticMappedFile {
  hunks: Hunk[];
  /** Full old file body, Pierre `isPartial: false` convention (lines keep their newline). */
  deletionLines: string[];
  /** Full new file body, same convention. */
  additionLines: string[];
  noveltySpans: DiffLineNoveltySpans;
  changeType: ChangeTypes;
}

export interface DifftasticMapFallback {
  fallback: DifftasticMapFallbackReason;
  detail: string;
}

export type DifftasticMapResult = DifftasticMappedFile | DifftasticMapFallback;

export interface MapDifftasticOptions {
  /** Context rows extended around each chunk span; matches Pierre's `parseDiffFromFile` default. */
  context?: number;
  /** Baseline change type from the Pierre parse, preserved so rename bookkeeping survives. */
  changeType?: ChangeTypes;
}

/** Narrow a map result to the fallback branch. */
export function isDifftasticMapFallback(
  result: DifftasticMapResult,
): result is DifftasticMapFallback {
  return "fallback" in result;
}

type RowKind = "context" | "deletion" | "addition" | "pair";

interface AlignedRow {
  lhs: number | null;
  rhs: number | null;
  /** Old-file lines consumed before this row; equals `lhs` when present. */
  oldIndex: number;
  /** New-file lines consumed before this row; equals `rhs` when present. */
  newIndex: number;
  kind: RowKind;
}

/** Pierre's full-contents convention: each line keeps its trailing newline; empty file = []. */
function splitFileLines(text: string): string[] {
  if (text === "") return [];
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const newlineIndex = text.indexOf("\n", start);
    if (newlineIndex === -1) break;
    lines.push(text.slice(start, newlineIndex + 1));
    start = newlineIndex + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** Line text as difftastic sees it: without the trailing newline. */
function stripEol(line: string): string {
  return line.endsWith("\n") ? line.slice(0, -1) : line;
}

/** Comparison key for aligned non-novel lines: token equality, whitespace-blind. */
function stripWhitespace(line: string): string {
  return line.replace(/\s+/g, "");
}

function emptyNovelty(
  deletionCount: number,
  additionCount: number,
): Required<DiffLineNoveltySpans> {
  return {
    additionLines: Array.from<ColumnSpan[] | undefined>({ length: additionCount }),
    deletionLines: Array.from<ColumnSpan[] | undefined>({ length: deletionCount }),
    additionWordLines: Array.from<ColumnSpan[] | undefined>({ length: additionCount }),
    deletionWordLines: Array.from<ColumnSpan[] | undefined>({ length: deletionCount }),
  };
}

function fallback(reason: DifftasticMapFallbackReason, detail: string): DifftasticMapFallback {
  return { fallback: reason, detail };
}

interface RowSpan {
  start: number;
  end: number;
}

/**
 * difftastic change-span columns count UTF-8 bytes; the render path slices JS
 * strings by UTF-16 code unit. Maps each code-point boundary's byte offset to
 * its code-unit offset; a byte offset inside a code point has no entry.
 */
function buildByteToCodeUnitMap(line: string): Map<number, number> {
  const map = new Map<number, number>([[0, 0]]);
  let byte = 0;
  let unit = 0;
  for (const char of line) {
    const codePoint = char.codePointAt(0) ?? 0;
    byte += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    unit += char.length;
    map.set(byte, unit);
  }
  return map;
}

/**
 * One side's whole body as a single document: every line with its EOL stripped,
 * joined by one newline.
 *
 * difftastic's unit is the atom, and a comment or string atom can span lines, so
 * the atom text has to be addressable across line boundaries. `lineStart` holds
 * each line's document offset plus a trailing sentinel, so line `i` occupies
 * `[lineStart[i], lineStart[i + 1] - 1)`.
 */
interface SideDocument {
  text: string;
  lineStart: number[];
}

/** One novel range in document coordinates, tagged with its kind and originating entry. */
interface NovelSpan {
  start: number;
  end: number;
  highlight: string;
  /** Index of the chunk entry this span came from, the unit run pairing is anchored to. */
  entry: number;
}

/** The novel document range of one atom, as one contiguous region. */
interface AtomRun {
  start: number;
  end: number;
  highlight: string;
  /** Spans difftastic emitted here: one for a whole-atom novel item, one per word otherwise. */
  spanCount: number;
  entry: number;
}

/** Changed-word columns recovered for one chunk, keyed by 0-based file line. */
interface NovelWordColumns {
  lhs: Map<number, ColumnSpan[]>;
  rhs: Map<number, ColumnSpan[]>;
}

/**
 * Whitespace that is not a line break: everything a run may step over inside one
 * atom.
 *
 * `split_atom_words` emits a position for every token of an atom it word-split
 * except a changed whitespace-only one, so the only source text between two spans
 * of the same atom is such a dropped token. A line break is the one whitespace
 * character that carries its own position when it is inside the atom (see
 * `toDocumentSpan`), so a line break left bare here separates two atoms.
 */
const INTRA_ATOM_GAP = /^(?:(?!\n)\p{White_Space})*$/u;

/** Build the joined document for one side's flat line array. */
function buildSideDocument(lines: string[]): SideDocument {
  const stripped = lines.map(stripEol);
  const lineStart: number[] = [];
  let offset = 0;
  for (const line of stripped) {
    lineStart.push(offset);
    offset += line.length + 1;
  }
  lineStart.push(offset);
  return { text: stripped.join("\n"), lineStart };
}

/** Text of one line, without its EOL. */
function documentLine(document: SideDocument, line: number): string {
  const start = document.lineStart[line] ?? 0;
  const end = (document.lineStart[line + 1] ?? start + 1) - 1;
  return document.text.slice(start, end);
}

/** Line a document offset falls on. */
function documentLineAt(document: SideDocument, offset: number): number {
  let low = 0;
  let high = document.lineStart.length - 2;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((document.lineStart[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Lift one line-relative column range into document coordinates.
 *
 * difftastic positions the newline token of a multi-line atom as a zero-width
 * span at the end of the line: `split_atom_words` calls
 * `from_region_relative_to`, which returns one span per line the token covers,
 * and keeps only the first. Restoring that token's real width is what lets a run
 * cross the line break, and it is why a bare line break in a gap means the spans
 * belong to different atoms.
 */
function toDocumentSpan(
  document: SideDocument,
  line: number,
  span: ColumnSpan,
  highlight: string,
  entry: number,
): NovelSpan {
  const base = document.lineStart[line] ?? 0;
  const isNewlineToken = span[0] === span[1] && span[0] === documentLine(document, line).length;
  return {
    start: base + span[0],
    end: base + span[1] + (isNewlineToken ? 1 : 0),
    highlight,
    entry,
  };
}

/**
 * Group one side's novel spans into the atoms they came from.
 *
 * difftastic emits one span per word for an atom it word-split and one span per
 * line for every other novel atom, so every span of a single atom carries that
 * atom's highlight and the run is contiguous apart from the tokens
 * `split_atom_words` dropped. A run therefore continues while the highlight
 * matches and the gap to the next span holds nothing but non-breaking whitespace;
 * any other gap starts the next atom.
 */
function groupAtomRuns(spans: NovelSpan[], text: string): AtomRun[] {
  const runs: AtomRun[] = [];
  for (const span of spans) {
    const current = runs[runs.length - 1];
    if (
      current != null &&
      current.highlight === span.highlight &&
      span.start >= current.end &&
      INTRA_ATOM_GAP.test(text.slice(current.end, span.start))
    ) {
      current.end = span.end;
      current.spanCount += 1;
      continue;
    }
    runs.push({
      start: span.start,
      end: span.end,
      highlight: span.highlight,
      spanCount: 1,
      entry: span.entry,
    });
  }
  return runs;
}

/** Record one recovered changed-word range against the line it sits on. */
function collectWordRange(
  target: Map<number, ColumnSpan[]>,
  document: SideDocument,
  start: number,
  end: number,
) {
  const line = documentLineAt(document, start);
  const base = document.lineStart[line] ?? 0;
  // A changed word is never whitespace, and every newline is its own token, so a
  // recovered range always sits inside one line.
  if (end > base + documentLine(document, line).length) return;
  const spans = target.get(line);
  if (spans == null) target.set(line, [[start - base, end - base]]);
  else spans.push([start - base, end - base]);
}

/**
 * Recover difftastic's changed-word tier for one chunk.
 *
 * The JSON keeps every novel span but drops which tier each one is (difftastic
 * issue #658), so the atom contents are rebuilt from the spans and the word diff
 * is re-run over them. The payload carries no atom identity, so runs are paired
 * positionally within the entry each one begins in: an entry naming both sides is
 * difftastic's own statement that those two lines are counterparts, and a
 * multi-line atom begins on counterpart lines.
 *
 * A run of one span is a whole-atom novel item, which is difftastic saying it did
 * not word-split that atom. Re-running the decision there could only contradict
 * it, so those runs are left alone. That also bounds the work: the token diff
 * never runs over an atom difftastic already rejected.
 */
function classifyChunkWords(
  lhs: { document: SideDocument; spans: NovelSpan[] },
  rhs: { document: SideDocument; spans: NovelSpan[] },
  pairedEntries: Set<number>,
): NovelWordColumns {
  const words: NovelWordColumns = { lhs: new Map(), rhs: new Map() };
  const lhsRuns = groupAtomRuns(lhs.spans, lhs.document.text);
  const rhsRuns = groupAtomRuns(rhs.spans, rhs.document.text);
  for (const entry of pairedEntries) {
    const lhsEntryRuns = lhsRuns.filter((run) => run.entry === entry);
    const rhsEntryRuns = rhsRuns.filter((run) => run.entry === entry);
    for (let index = 0; index < Math.min(lhsEntryRuns.length, rhsEntryRuns.length); index++) {
      const lhsRun = lhsEntryRuns[index]!;
      const rhsRun = rhsEntryRuns[index]!;
      if (lhsRun.spanCount < 2 || rhsRun.spanCount < 2) continue;
      if (!isWordSplitScope(lhsRun.highlight, rhsRun.highlight)) continue;
      const ranges = classifyNovelWords(
        lhs.document.text.slice(lhsRun.start, lhsRun.end),
        rhs.document.text.slice(rhsRun.start, rhsRun.end),
      );
      if (ranges == null) continue;
      for (const [start, end] of ranges.lhs) {
        collectWordRange(words.lhs, lhs.document, lhsRun.start + start, lhsRun.start + end);
      }
      for (const [start, end] of ranges.rhs) {
        collectWordRange(words.rhs, rhs.document, rhsRun.start + start, rhsRun.start + end);
      }
    }
  }
  return words;
}

/** Sort spans, then merge every pair that overlaps or touches into one span. */
function mergeRowSpans(spans: RowSpan[]): RowSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: RowSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last != null && span.start <= last.end + 1) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

export function mapDifftasticFile(
  json: DifftasticFile,
  oldText: string,
  newText: string,
  options: MapDifftasticOptions = {},
): DifftasticMapResult {
  const changeType = options.changeType ?? "change";
  const context = options.context ?? 3;
  const deletionLines = splitFileLines(oldText);
  const additionLines = splitFileLines(newText);
  const oldLen = deletionLines.length;
  const newLen = additionLines.length;

  if (json.status === "unchanged") {
    // difftastic found no structural change (it may still differ textually,
    // e.g. a trailing-newline-only edit); the file renders hunkless.
    return {
      hunks: [],
      deletionLines,
      additionLines,
      noveltySpans: emptyNovelty(oldLen, newLen),
      changeType,
    };
  }
  if (json.status !== "changed") {
    return fallback("unsupported-status", `status "${json.status}"`);
  }
  const aligned = json.aligned_lines;
  const chunks = json.chunks;
  if (aligned == null || chunks == null) {
    return fallback("missing-alignment", 'status "changed" without aligned_lines/chunks');
  }

  // difftastic's line model always carries a phantom empty EOF line per side
  // (index == real line count); phantom-only rows are alignment artifacts and
  // are dropped, keeping row indexes aligned with the Pierre arrays.
  const phantomOld = oldLen;
  const phantomNew = newLen;
  const rows: AlignedRow[] = [];
  let oldSeen = 0;
  let newSeen = 0;
  for (const [lhs, rhs] of aligned) {
    if (lhs == null && rhs == null) {
      return fallback("invalid-alignment", "row with both sides null");
    }
    if (lhs != null) {
      // Whole-file coverage in order: the k-th old reference must be line k.
      if (lhs !== oldSeen || lhs > phantomOld) {
        return fallback("invalid-alignment", `lhs ${lhs} where line ${oldSeen} was expected`);
      }
      oldSeen += 1;
    }
    if (rhs != null) {
      if (rhs !== newSeen || rhs > phantomNew) {
        return fallback("invalid-alignment", `rhs ${rhs} where line ${newSeen} was expected`);
      }
      newSeen += 1;
    }
    const oldIsPhantom = lhs === phantomOld;
    const newIsPhantom = rhs === phantomNew;
    if (oldIsPhantom || newIsPhantom) {
      if ((lhs != null && !oldIsPhantom) || (rhs != null && !newIsPhantom)) {
        return fallback("invalid-alignment", "phantom EOF line paired with a real line");
      }
      continue;
    }
    rows.push({
      lhs,
      rhs,
      oldIndex: lhs ?? oldSeen,
      newIndex: rhs ?? newSeen,
      kind: "context",
    });
  }
  if (oldSeen < oldLen || newSeen < newLen) {
    return fallback(
      "invalid-alignment",
      `aligned_lines covers ${oldSeen}/${oldLen} old and ${newSeen}/${newLen} new lines`,
    );
  }

  const oldLineToRow = new Map<number, number>();
  const newLineToRow = new Map<number, number>();
  rows.forEach((row, index) => {
    if (row.lhs != null) oldLineToRow.set(row.lhs, index);
    if (row.rhs != null) newLineToRow.set(row.rhs, index);
  });

  // Novelty index over chunks: column spans per (side, line) remapped from
  // UTF-8 byte offsets to code-unit offsets, plus which lines carry nonempty
  // spans (those force modified-pair rows).
  const lhsSpans = new Map<number, ColumnSpan[]>();
  const rhsSpans = new Map<number, ColumnSpan[]>();
  const lhsWords = new Map<number, ColumnSpan[]>();
  const rhsWords = new Map<number, ColumnSpan[]>();
  const novelLhs = new Set<number>();
  const novelRhs = new Set<number>();
  const documents = {
    lhs: buildSideDocument(deletionLines),
    rhs: buildSideDocument(additionLines),
  };
  const byteMaps = {
    lhs: new Map<number, Map<number, number>>(),
    rhs: new Map<number, Map<number, number>>(),
  };
  const appendSpans = (store: Map<number, ColumnSpan[]>, line: number, spans: ColumnSpan[]) => {
    store.set(line, [...(store.get(line) ?? []), ...spans]);
  };
  const chunkSpans: RowSpan[] = [];
  for (const chunk of chunks) {
    let minRow = Number.POSITIVE_INFINITY;
    let maxRow = Number.NEGATIVE_INFINITY;
    // An atom can span lines, so the changed-word tier is recovered per chunk
    // rather than per entry; entries that name both sides anchor run pairing.
    const chunkNovel = { lhs: [] as NovelSpan[], rhs: [] as NovelSpan[] };
    const pairedEntries = new Set<number>();
    for (const [entryIndex, entry] of chunk.entries()) {
      let sidesPresent = 0;
      for (const side of ["lhs", "rhs"] as const) {
        const sideEntry = entry[side];
        if (sideEntry == null) continue;
        const phantom = side === "lhs" ? phantomOld : phantomNew;
        if (sideEntry.line_number === phantom) continue;
        if (sideEntry.line_number > phantom) {
          return fallback("chunk-out-of-bounds", `${side} line ${sideEntry.line_number}`);
        }
        const rowIndex = (side === "lhs" ? oldLineToRow : newLineToRow).get(sideEntry.line_number);
        if (rowIndex == null) {
          return fallback("chunk-out-of-bounds", `${side} line ${sideEntry.line_number} unaligned`);
        }
        const document = documents[side];
        let byteMap = byteMaps[side].get(sideEntry.line_number);
        if (byteMap == null) {
          byteMap = buildByteToCodeUnitMap(documentLine(document, sideEntry.line_number));
          byteMaps[side].set(sideEntry.line_number, byteMap);
        }
        const spans: ColumnSpan[] = [];
        for (const change of sideEntry.changes) {
          const start = byteMap.get(change.start);
          const end = byteMap.get(change.end);
          if (start == null || end == null) {
            return fallback(
              "invalid-span",
              `${side} line ${sideEntry.line_number} bytes [${change.start},${change.end}) off code-point boundaries`,
            );
          }
          spans.push([start, end]);
          chunkNovel[side].push(
            toDocumentSpan(
              document,
              sideEntry.line_number,
              [start, end],
              change.highlight,
              entryIndex,
            ),
          );
        }
        appendSpans(side === "lhs" ? lhsSpans : rhsSpans, sideEntry.line_number, spans);
        if (spans.length > 0) (side === "lhs" ? novelLhs : novelRhs).add(sideEntry.line_number);
        minRow = Math.min(minRow, rowIndex);
        maxRow = Math.max(maxRow, rowIndex);
        sidesPresent += 1;
      }
      if (sidesPresent === 2) pairedEntries.add(entryIndex);
    }
    const words = classifyChunkWords(
      { document: documents.lhs, spans: chunkNovel.lhs },
      { document: documents.rhs, spans: chunkNovel.rhs },
      pairedEntries,
    );
    for (const [line, spans] of words.lhs) appendSpans(lhsWords, line, spans);
    for (const [line, spans] of words.rhs) appendSpans(rhsWords, line, spans);
    if (minRow <= maxRow) chunkSpans.push({ start: minRow, end: maxRow });
  }

  const noveltySpans = emptyNovelty(oldLen, newLen);
  for (const row of rows) {
    if (row.lhs != null && row.rhs == null) {
      // Deleted line: novel by position even without a chunk entry. No opposite
      // line means no atom pair, so the changed-word tier is empty by definition.
      row.kind = "deletion";
      noveltySpans.deletionLines[row.lhs] = lhsSpans.get(row.lhs) ?? [];
      noveltySpans.deletionWordLines[row.lhs] = lhsWords.get(row.lhs) ?? [];
    } else if (row.lhs == null && row.rhs != null) {
      row.kind = "addition";
      noveltySpans.additionLines[row.rhs] = rhsSpans.get(row.rhs) ?? [];
      noveltySpans.additionWordLines[row.rhs] = rhsWords.get(row.rhs) ?? [];
    } else if (row.lhs != null && row.rhs != null) {
      if (novelLhs.has(row.lhs) || novelRhs.has(row.rhs)) {
        // Modified pair; a side with an empty `changes` entry is still novel.
        row.kind = "pair";
        noveltySpans.deletionLines[row.lhs] = lhsSpans.get(row.lhs) ?? [];
        noveltySpans.additionLines[row.rhs] = rhsSpans.get(row.rhs) ?? [];
        noveltySpans.deletionWordLines[row.lhs] = lhsWords.get(row.lhs) ?? [];
        noveltySpans.additionWordLines[row.rhs] = rhsWords.get(row.rhs) ?? [];
      } else {
        row.kind = "context";
        // difftastic aligns reformatted lines as non-novel (whitespace is not a
        // token), so context texts may legally differ in whitespace only; each
        // side renders its own text from the full-file flat arrays.
        if (
          stripWhitespace(deletionLines[row.lhs] ?? "") !==
          stripWhitespace(additionLines[row.rhs] ?? "")
        ) {
          return fallback(
            "context-mismatch",
            `old line ${row.lhs} and new line ${row.rhs} differ without a chunk entry`,
          );
        }
      }
    }
  }

  // Candidate hunk spans: one per chunk, plus runs of novel rows no chunk
  // covers (an inserted blank line has no chunk entry at all).
  const candidates: RowSpan[] = [...chunkSpans];
  let runStart = -1;
  for (let index = 0; index <= rows.length; index++) {
    const row = rows[index];
    const novel = row != null && row.kind !== "context";
    if (novel && runStart === -1) runStart = index;
    if (!novel && runStart !== -1) {
      candidates.push({ start: runStart, end: index - 1 });
      runStart = -1;
    }
  }
  const hunkSpans = mergeRowSpans(
    candidates.map((span) => ({
      start: Math.max(0, span.start - context),
      end: Math.min(rows.length - 1, span.end + context),
    })),
  );

  const oldNoEol = oldText !== "" && !oldText.endsWith("\n");
  const newNoEol = newText !== "" && !newText.endsWith("\n");
  const hunks: Hunk[] = [];
  let previousEnd = -1;
  let fileSplitCount = 0;
  let fileUnifiedCount = 0;
  for (const span of hunkSpans) {
    const firstRow = rows[span.start];
    if (firstRow == null) continue;
    let oldCount = 0;
    let newCount = 0;
    let deletedLines = 0;
    let addedLines = 0;
    let lastOldLine = -1;
    let lastNewLine = -1;
    let runKind: RowKind | undefined;
    let runBlock: ContextContent | ChangeContent | undefined;
    const hunkContent: (ContextContent | ChangeContent)[] = [];
    for (let index = span.start; index <= span.end; index++) {
      const row = rows[index];
      if (row == null) continue;
      if (row.lhs != null) {
        oldCount += 1;
        lastOldLine = row.lhs;
      }
      if (row.rhs != null) {
        newCount += 1;
        lastNewLine = row.rhs;
      }
      if (row.kind === "deletion" || row.kind === "pair") deletedLines += 1;
      if (row.kind === "addition" || row.kind === "pair") addedLines += 1;
      if (runBlock != null && runKind === row.kind) {
        // Extend the current maximal homogeneous run.
        if (runBlock.type === "context") {
          runBlock.lines += 1;
        } else {
          if (row.kind !== "addition") runBlock.deletions += 1;
          if (row.kind !== "deletion") runBlock.additions += 1;
        }
        continue;
      }
      runKind = row.kind;
      runBlock =
        row.kind === "context"
          ? {
              type: "context",
              lines: 1,
              additionLineIndex: row.newIndex,
              deletionLineIndex: row.oldIndex,
            }
          : {
              type: "change",
              deletions: row.kind === "addition" ? 0 : 1,
              deletionLineIndex: row.oldIndex,
              additions: row.kind === "deletion" ? 0 : 1,
              additionLineIndex: row.newIndex,
            };
      hunkContent.push(runBlock);
    }

    let splitLineCount = 0;
    let unifiedLineCount = 0;
    for (const block of hunkContent) {
      if (block.type === "context") {
        splitLineCount += block.lines;
        unifiedLineCount += block.lines;
      } else {
        splitLineCount += Math.max(block.additions, block.deletions);
        unifiedLineCount += block.additions + block.deletions;
      }
    }

    const collapsedBefore = span.start - previousEnd - 1;
    hunks.push({
      collapsedBefore,
      // Unified-diff convention: an empty side reports the running counter
      // (the 1-based line before the hunk) rather than counter + 1.
      additionStart: newCount > 0 ? firstRow.newIndex + 1 : firstRow.newIndex,
      additionCount: newCount,
      additionLines: addedLines,
      additionLineIndex: firstRow.newIndex,
      deletionStart: oldCount > 0 ? firstRow.oldIndex + 1 : firstRow.oldIndex,
      deletionCount: oldCount,
      deletionLines: deletedLines,
      deletionLineIndex: firstRow.oldIndex,
      hunkContent,
      splitLineStart: fileSplitCount + collapsedBefore,
      splitLineCount,
      unifiedLineStart: fileUnifiedCount + collapsedBefore,
      unifiedLineCount,
      // Meaningful only on the hunk that reaches the file's last line.
      noEOFCRDeletions: oldNoEol && lastOldLine === oldLen - 1,
      noEOFCRAdditions: newNoEol && lastNewLine === newLen - 1,
    });
    fileSplitCount += collapsedBefore + splitLineCount;
    fileUnifiedCount += collapsedBefore + unifiedLineCount;
    previousEnd = span.end;
  }

  return { hunks, deletionLines, additionLines, noveltySpans, changeType };
}
