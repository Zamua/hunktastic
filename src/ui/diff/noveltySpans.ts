import { validateTabWidth } from "../../core/tabWidth";
import type { ColumnSpan } from "../../core/types";
import { isPrintableAsciiText, measureTextWidth } from "../lib/text";
import type { RenderSpan } from "./diffRowModel";
import { snapToClusterBoundary } from "./lineHighlightPaint";

/**
 * Widen range boundaries outward to grapheme-cluster boundaries of the concatenated
 * span text, so a mid-cluster range marks the whole glyph instead of tearing it.
 */
function snapColumnSpansToClusters(spans: RenderSpan[], columnSpans: ColumnSpan[]): ColumnSpan[] {
  const text = spans.map((span) => span.text).join("");
  if (isPrintableAsciiText(text)) {
    return columnSpans;
  }

  return columnSpans.map(
    ([start, end]) =>
      [
        snapToClusterBoundary(text, start, "down"),
        snapToClusterBoundary(text, end, "up"),
      ] as ColumnSpan,
  );
}

/** Clamp, sort, and merge column spans into disjoint ascending ranges within [0, maxColumn]. */
function normalizeColumnSpans(columnSpans: ColumnSpan[], maxColumn: number): ColumnSpan[] {
  const clamped: ColumnSpan[] = [];
  for (const [start, end] of columnSpans) {
    const spanStart = Math.max(0, Math.min(start, maxColumn));
    const spanEnd = Math.max(0, Math.min(end, maxColumn));
    if (spanEnd > spanStart) {
      clamped.push([spanStart, spanEnd]);
    }
  }

  clamped.sort((a, b) => a[0] - b[0]);

  const merged: ColumnSpan[] = [];
  for (const span of clamped) {
    const previous = merged[merged.length - 1];
    if (previous && span[0] <= previous[1]) {
      previous[1] = Math.max(previous[1], span[1]);
      continue;
    }

    merged.push([span[0], span[1]]);
  }

  return merged;
}

/**
 * Style applied to the emphasized column ranges. Absent fields inherit the underlying
 * span's value, so a foreground emphasis (difftastic novel tokens) keeps the row
 * background and an attribute-only emphasis (difftastic changed words) keeps both
 * colors. There is no background field: difftastic leaves the whitespace between its
 * per-token spans in no span at all, so a painted background shows a hole at every gap.
 */
export interface NoveltyEmphasis {
  fg?: string;
  bold?: boolean;
  underline?: boolean;
}

/**
 * Restyle flattened render spans with an emphasis style over the given column ranges.
 *
 * Columns are 0-based, end-exclusive string indexes into the concatenated span text.
 * Out-of-bounds columns are clamped, boundaries inside a grapheme cluster widen outward
 * to whole glyphs, and empty or inverted ranges are dropped; when no range survives,
 * the input array is returned unchanged. Input spans are never mutated: the
 * flattened-span cache shares arrays across rows and renders, so emphasis always builds
 * new span objects.
 */
export function overlayNoveltySpans(
  spans: RenderSpan[],
  columnSpans: ColumnSpan[],
  emphasis: NoveltyEmphasis,
): RenderSpan[] {
  if (spans.length === 0 || columnSpans.length === 0) {
    return spans;
  }

  let totalLength = 0;
  for (const span of spans) {
    totalLength += span.text.length;
  }

  // Snap before merging so ranges widened onto the same cluster collapse back into one.
  const ranges = normalizeColumnSpans(snapColumnSpansToClusters(spans, columnSpans), totalLength);
  if (ranges.length === 0) {
    return spans;
  }

  const result: RenderSpan[] = [];
  const push = (text: string, style: Omit<RenderSpan, "text">) => {
    if (text.length === 0) {
      return;
    }

    // Coalesce identical adjacent styling the same way the flattening pass does.
    const previous = result[result.length - 1];
    if (
      previous &&
      previous.fg === style.fg &&
      previous.bg === style.bg &&
      previous.bold === style.bold &&
      previous.underline === style.underline
    ) {
      previous.text += text;
      return;
    }

    const next: RenderSpan = { text };
    if (style.fg !== undefined) {
      next.fg = style.fg;
    }
    if (style.bg !== undefined) {
      next.bg = style.bg;
    }
    if (style.bold !== undefined) {
      next.bold = style.bold;
    }
    if (style.underline !== undefined) {
      next.underline = style.underline;
    }
    result.push(next);
  };

  let offset = 0;
  let rangeIndex = 0;
  for (const span of spans) {
    const plain: Omit<RenderSpan, "text"> = {
      fg: span.fg,
      bg: span.bg,
      bold: span.bold,
      underline: span.underline,
    };
    // Absent emphasis fields fall through to the span's own value, so stacking a
    // second emphasis pass keeps whatever the first one applied.
    const emphasized: Omit<RenderSpan, "text"> = {
      fg: emphasis.fg ?? span.fg,
      bg: span.bg,
      bold: emphasis.bold ? true : span.bold,
      underline: emphasis.underline ? true : span.underline,
    };
    const spanStart = offset;
    const spanEnd = offset + span.text.length;
    let cursor = spanStart;

    while (cursor < spanEnd) {
      let activeRange = ranges[rangeIndex];
      while (activeRange && activeRange[1] <= cursor) {
        rangeIndex += 1;
        activeRange = ranges[rangeIndex];
      }

      if (!activeRange || activeRange[0] >= spanEnd) {
        push(span.text.slice(cursor - spanStart), plain);
        break;
      }

      if (activeRange[0] > cursor) {
        push(span.text.slice(cursor - spanStart, activeRange[0] - spanStart), plain);
        cursor = activeRange[0];
      }

      const emphasisEnd = Math.min(activeRange[1], spanEnd);
      push(span.text.slice(cursor - spanStart, emphasisEnd - spanStart), emphasized);
      cursor = emphasisEnd;
    }

    offset = spanEnd;
  }

  return result;
}

/**
 * Remap 0-based, end-exclusive source column spans through tab expansion.
 *
 * difftastic columns index the raw source line, but rendered spans hold tab-expanded
 * text; the returned spans index that expanded text. Cell columns advance exactly like
 * `expandDiffTabs` so each tab maps to the same run of spaces the renderer emits.
 */
export function remapColumnSpansThroughTabs(
  lineText: string,
  columnSpans: ColumnSpan[],
  tabWidth: number,
): ColumnSpan[] {
  if (columnSpans.length === 0 || !lineText.includes("\t")) {
    return columnSpans;
  }

  const resolvedTabWidth = validateTabWidth(tabWidth);
  // expandedAt[i] = expanded-text index of source code unit i, plus one end-of-line slot.
  const expandedAt: number[] = [];
  let sourceIndex = 0;
  let expandedIndex = 0;
  let column = 0;

  for (const [segmentIndex, segment] of lineText.split("\t").entries()) {
    if (segmentIndex > 0) {
      // The tab character itself maps to the start of its expansion run.
      expandedAt[sourceIndex] = expandedIndex;
      const spaces = resolvedTabWidth - (column % resolvedTabWidth);
      sourceIndex += 1;
      expandedIndex += spaces;
      column += spaces;
    }

    for (let unit = 0; unit < segment.length; unit += 1) {
      expandedAt[sourceIndex + unit] = expandedIndex + unit;
    }
    sourceIndex += segment.length;
    expandedIndex += segment.length;
    column += measureTextWidth(segment);
  }
  expandedAt[sourceIndex] = expandedIndex;

  const endOfLine = expandedIndex;
  const remapOffset = (offset: number) =>
    expandedAt[Math.max(0, Math.min(offset, lineText.length))] ?? endOfLine;

  return columnSpans.map(([start, end]) => [remapOffset(start), remapOffset(end)] as ColumnSpan);
}
