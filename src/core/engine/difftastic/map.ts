import type { ChangeContent, ChangeTypes, ContextContent, Hunk } from "@pierre/diffs";
import type { ColumnSpan, DiffLineNoveltySpans } from "../../types";
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

function emptyNovelty(deletionCount: number, additionCount: number): DiffLineNoveltySpans {
  return {
    additionLines: Array.from<ColumnSpan[] | undefined>({ length: additionCount }),
    deletionLines: Array.from<ColumnSpan[] | undefined>({ length: deletionCount }),
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
  const novelLhs = new Set<number>();
  const novelRhs = new Set<number>();
  const byteMaps = {
    lhs: new Map<number, Map<number, number>>(),
    rhs: new Map<number, Map<number, number>>(),
  };
  const chunkSpans: RowSpan[] = [];
  for (const chunk of chunks) {
    let minRow = Number.POSITIVE_INFINITY;
    let maxRow = Number.NEGATIVE_INFINITY;
    for (const entry of chunk) {
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
        let byteMap = byteMaps[side].get(sideEntry.line_number);
        if (byteMap == null) {
          const lineText = stripEol(
            (side === "lhs" ? deletionLines : additionLines)[sideEntry.line_number] ?? "",
          );
          byteMap = buildByteToCodeUnitMap(lineText);
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
        }
        const store = side === "lhs" ? lhsSpans : rhsSpans;
        store.set(sideEntry.line_number, [...(store.get(sideEntry.line_number) ?? []), ...spans]);
        if (spans.length > 0) (side === "lhs" ? novelLhs : novelRhs).add(sideEntry.line_number);
        minRow = Math.min(minRow, rowIndex);
        maxRow = Math.max(maxRow, rowIndex);
      }
    }
    if (minRow <= maxRow) chunkSpans.push({ start: minRow, end: maxRow });
  }

  const noveltySpans = emptyNovelty(oldLen, newLen);
  for (const row of rows) {
    if (row.lhs != null && row.rhs == null) {
      // Deleted line: novel by position even without a chunk entry.
      row.kind = "deletion";
      noveltySpans.deletionLines[row.lhs] = lhsSpans.get(row.lhs) ?? [];
    } else if (row.lhs == null && row.rhs != null) {
      row.kind = "addition";
      noveltySpans.additionLines[row.rhs] = rhsSpans.get(row.rhs) ?? [];
    } else if (row.lhs != null && row.rhs != null) {
      if (novelLhs.has(row.lhs) || novelRhs.has(row.rhs)) {
        // Modified pair; a side with an empty `changes` entry is still novel.
        row.kind = "pair";
        noveltySpans.deletionLines[row.lhs] = lhsSpans.get(row.lhs) ?? [];
        noveltySpans.additionLines[row.rhs] = rhsSpans.get(row.rhs) ?? [];
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
