/**
 * Re-anchors mutable review notes against the current semantic document.
 *
 * The textual ladder itself lives in `src/core/notes/resolve.ts`; this module turns a
 * `ReviewFileV1` into the corpora that ladder reads, places each resolved line back onto
 * current hunk geometry, and maps the ladder's verdicts onto `ReviewNoteResolution`. The
 * reducer runs it on `notes/restore` and again on every `document/reconcile`, so a note's
 * resolution is a fact of the document it currently faces, not of the session that
 * authored it.
 *
 * Everything here is pure over `(quotes, files, loaded source text)`; persistence never
 * appears. Line corpora include expanded-gap content when the review holds the source
 * text behind it, which is what lets a note authored on an expanded gap line carry a
 * non-blank quote and re-anchor later.
 */
import {
  captureNoteAnchor,
  resolveNotes,
  type NoteAnchorFields,
  type NoteResolutionFile,
  type NoteResolutionState,
} from "../notes/resolve";
import { NOTE_CONTEXT_LINES, type StoredNote } from "../notes/types";
import type { ReviewNoteSource } from "../types";
import { reviewGapOwnerHunkIndex, reviewLineAnchor } from "./anchors";
import {
  reviewExpansionSide,
  reviewGapSourceForFile,
  reviewLeadingGap,
  reviewTrailingGap,
} from "./expansion";
import { normalizedReviewSourceLines, reviewHunkIndexForLine } from "./geometry";
import type {
  ReviewNoteQuote,
  ReviewNoteResolution,
  ReviewSourceStatus,
  ReviewStoredNote,
} from "./state";
import type { ReviewFileV1, ReviewLineRange, ReviewRangeAnchorV1, ReviewSide } from "./types";

/** Map the resolver's verdict onto the stored-note vocabulary: only a moved line is still active. */
export function reviewNoteResolutionFromState(state: NoteResolutionState): ReviewNoteResolution {
  if (state === "orphaned") {
    return "orphaned";
  }
  return state === "unanchored" ? "stale" : "active";
}

/** Normalize a persisted note's raw source label into the shared source vocabulary. */
export function reviewNoteSourceFromStoredLabel(label: string): ReviewNoteSource {
  if (label === "user") {
    return "user";
  }
  return label === "mcp" || label === "agent" ? "agent" : "ai";
}

/** Read loaded expansion-side source text for one file out of the review's status map. */
export function reviewLoadedSourceTextFor(
  sourceStatusByFileKey: Record<string, ReviewSourceStatus>,
): (file: ReviewFileV1) => string | undefined {
  return (file) => {
    const status = sourceStatusByFileKey[file.key];
    return status?.kind === "loaded" ? status.text : undefined;
  };
}

/** Drop the line terminator the parsed diff keeps on each line. */
function stripLineTerminator(text: string) {
  return text.replace(/\r?\n$/, "");
}

/**
 * Read one side of a semantic file as lines indexed by their own line number.
 *
 * Hunk-covered lines come from the patch. The gaps between them fill from what the
 * review actually knows: a complete diff carries the whole file in its side arrays, and
 * a partial one can borrow gap lines from loaded expansion source text, since gap rows are
 * unchanged context, so both sides read the expansion side's text through the gap's
 * range mapping. Lines nothing attests stay holes, which the matcher treats as absent.
 */
export function reviewNoteCorpus(
  file: ReviewFileV1,
  side: ReviewSide,
  sourceText?: string,
): string[] {
  const source = side === "new" ? file.additionLines : file.deletionLines;
  const lines: string[] = [];

  for (const hunk of file.hunks) {
    const start = side === "new" ? hunk.additionStart : hunk.deletionStart;
    const count = side === "new" ? hunk.additionCount : hunk.deletionCount;
    const sourceIndex = side === "new" ? hunk.additionLineIndex : hunk.deletionLineIndex;

    for (let offset = 0; offset < count; offset += 1) {
      const text = source[sourceIndex + offset];
      const line = start + offset;
      if (text === undefined || line < 1) {
        continue;
      }

      lines[line - 1] = stripLineTerminator(text);
    }
  }

  if (!file.flags.partial) {
    // A complete diff's side arrays are the whole file, index-aligned with line numbers.
    for (let index = 0; index < source.length; index += 1) {
      lines[index] ??= stripLineTerminator(source[index]!);
    }
    return lines;
  }

  if (sourceText === undefined) {
    return lines;
  }

  const expansionSide = reviewExpansionSide(file.changeKind);
  const sourceLines = normalizedReviewSourceLines(sourceText);
  const gapSource = reviewGapSourceForFile(file);
  const gaps = [
    ...file.hunks.map((_hunk, index) => reviewLeadingGap(gapSource, index)),
    reviewTrailingGap(gapSource),
  ];
  for (const gap of gaps) {
    if (!gap) {
      continue;
    }
    const [start, end] = side === "old" ? gap.oldRange : gap.newRange;
    const [expansionStart] = expansionSide === "old" ? gap.oldRange : gap.newRange;
    for (let line = start; line <= end; line += 1) {
      const text = sourceLines[expansionStart + (line - start) - 1];
      if (text !== undefined) {
        lines[line - 1] ??= text;
      }
    }
  }

  return lines;
}

/**
 * Capture the quote one note re-anchors by, against the corpus the review holds now.
 *
 * The context window stops at the first hole in the corpus on each side, because a quote
 * spanning a line the review never attested could not match anything on a later load.
 */
export function captureReviewNoteQuote(
  file: ReviewFileV1,
  side: ReviewSide,
  line: number,
  sourceText?: string,
): ReviewNoteQuote {
  const lines = reviewNoteCorpus(file, side, sourceText);

  let start = line;
  while (start > 1 && line - start < NOTE_CONTEXT_LINES && lines[start - 2] !== undefined) {
    start -= 1;
  }

  let end = line;
  while (end - line < NOTE_CONTEXT_LINES && lines[end] !== undefined) {
    end += 1;
  }

  return {
    filePath: file.path,
    side,
    line,
    ...captureNoteAnchor(lines.slice(start - 1, end), line - start + 1),
  };
}

/** Where one re-anchored note hangs in the current document. */
export interface ReviewQuotePlacement {
  hunkIndex: number;
  side: ReviewSide;
  line: number;
  anchor: ReviewRangeAnchorV1;
}

/** One quote's verdict against the current document. */
export interface ReviewQuoteResolution {
  resolution: ReviewNoteResolution;
  /** Low when several identical anchors forced a nearest-hit pick. */
  confidence: "high" | "low";
  /** The file the note belongs to now; absent when the review no longer has it. */
  fileKey?: string;
  /** Absent for orphaned notes and for files with no hunk to hang from. */
  placement?: ReviewQuotePlacement;
}

interface IndexedQuote extends NoteAnchorFields {
  index: number;
}

/**
 * Resolve stored quotes against the current document.
 *
 * A quote is resolved against the side it was written on. New-side quotes go through the
 * resolver's ladder against current contents; old-side quotes try that first (a line
 * that survived the diff ports forward) and fall back to the before-image they were
 * authored in. Placement is permissive: a line outside every hunk, or a quote whose text
 * no longer matches anywhere, stays placed at its stored coordinates and hangs from the
 * gap-owner hunk. Only a missing file orphans a note, and only a zero-hunk file leaves
 * one without a placement.
 */
export function resolveReviewNoteQuotes(
  quotes: readonly ReviewNoteQuote[],
  files: readonly ReviewFileV1[],
  sourceTextForFile: (file: ReviewFileV1) => string | undefined = () => undefined,
): ReviewQuoteResolution[] {
  const corpora = new Map<ReviewFileV1, { new?: NoteResolutionFile; old?: NoteResolutionFile }>();
  const sideFile = (file: ReviewFileV1, side: ReviewSide): NoteResolutionFile => {
    const cached = corpora.get(file) ?? {};
    const existing = cached[side];
    if (existing) {
      return existing;
    }

    const entry: NoteResolutionFile = {
      path: file.path,
      ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
      // The before-image is the space an old-side line was written in, so no edit list
      // applies to it; an empty one is how that identity mapping is expressed.
      hunks: side === "new" ? file.hunks : [],
      lines: reviewNoteCorpus(file, side, sourceTextForFile(file)),
    };
    cached[side] = entry;
    corpora.set(file, cached);
    return entry;
  };

  const placementFor = (
    file: ReviewFileV1,
    side: ReviewSide,
    line: number,
  ): ReviewQuotePlacement | undefined => {
    const hunks = file.hunks;
    const containing = reviewHunkIndexForLine(hunks, side, line);
    // A line no hunk contains sits in a collapsed gap; the gap-owner hunk hangs it.
    const hunkIndex = containing >= 0 ? containing : reviewGapOwnerHunkIndex(hunks, side, line);
    if (hunkIndex === undefined) {
      return undefined;
    }

    return { hunkIndex, side, line, anchor: reviewLineAnchor(hunks, { hunkIndex, side, line }) };
  };

  const resolveAgainst = (
    entries: ReadonlyArray<{ quote: IndexedQuote; file: ReviewFileV1 }>,
    side: ReviewSide,
  ) =>
    resolveNotes(
      entries.map((entry) => entry.quote),
      [...new Set(entries.map((entry) => sideFile(entry.file, side)))],
    );

  const targets = quotes.map((quote, index) => ({
    quote: { ...quote, index } satisfies IndexedQuote,
    file: files.find(
      (candidate) => candidate.path === quote.filePath || candidate.previousPath === quote.filePath,
    ),
  }));
  const placeable = targets.filter(
    (target): target is { quote: IndexedQuote; file: ReviewFileV1 } => target.file !== undefined,
  );
  const primary = new Map(
    resolveAgainst(placeable, "new").map((resolved) => [resolved.note.index, resolved]),
  );

  const fallbackTargets = placeable.filter((target) => {
    const resolved = primary.get(target.quote.index);
    return (
      target.quote.side === "old" &&
      (resolved?.line === undefined || !placementFor(target.file, "new", resolved.line))
    );
  });
  const fallback = new Map(
    resolveAgainst(fallbackTargets, "old").map((resolved) => [resolved.note.index, resolved]),
  );

  return targets.map(({ quote, file }) => {
    if (!file) {
      return { resolution: "orphaned", confidence: "high" } satisfies ReviewQuoteResolution;
    }

    for (const [side, resolved] of [
      ["new", primary.get(quote.index)],
      ["old", fallback.get(quote.index)],
    ] as const) {
      if (resolved?.line === undefined) {
        continue;
      }

      const placement = placementFor(file, side, resolved.line);
      if (placement) {
        return {
          resolution: reviewNoteResolutionFromState(resolved.state),
          confidence: resolved.confidence,
          fileKey: file.key,
          placement,
        } satisfies ReviewQuoteResolution;
      }
    }

    // No surviving line: the note keeps its stored coordinates, hung from the gap-owner
    // hunk, so degrading to stale never costs the placement.
    const placement = placementFor(file, quote.side, quote.line);
    return {
      resolution: "stale",
      confidence: "high",
      fileKey: file.key,
      ...(placement ? { placement } : {}),
    } satisfies ReviewQuoteResolution;
  });
}

/** Compare two inclusive ranges by value, treating two absents as equal. */
function rangesEqual(left?: ReviewLineRange, right?: ReviewLineRange) {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return left[0] === right[0] && left[1] === right[1];
}

/** Compare two note anchors by value so an unchanged reconciliation stays a no-op. */
function reviewAnchorsEqual(left: ReviewRangeAnchorV1, right: ReviewRangeAnchorV1) {
  return (
    rangesEqual(left.oldRange, right.oldRange) &&
    rangesEqual(left.newRange, right.newRange) &&
    left.preferred?.side === right.preferred?.side &&
    left.preferred?.line === right.preferred?.line &&
    left.ownerHunkIndex === right.ownerHunkIndex &&
    left.intersectingHunkIndices.length === right.intersectingHunkIndices.length &&
    left.intersectingHunkIndices.every(
      (value, index) => value === right.intersectingHunkIndices[index],
    )
  );
}

/**
 * Attach the quote a freshly stored note re-anchors by.
 *
 * Runs when a note enters the store, against the document the author was looking at. A
 * note that already carries a quote (one restored from disk) keeps it, because stored
 * coordinates are never rewritten. A note whose file or preferred line cannot be read
 * stays quoteless and simply never re-anchors.
 */
export function withReviewNoteQuote(
  entry: ReviewStoredNote,
  files: readonly ReviewFileV1[],
  sourceTextForFile: (file: ReviewFileV1) => string | undefined,
): ReviewStoredNote {
  if (entry.quote) {
    return entry;
  }

  const file = files.find((candidate) => candidate.key === entry.note.fileKey);
  const preferred = entry.note.anchor.preferred;
  if (!file || !preferred) {
    return entry;
  }

  return {
    ...entry,
    quote: captureReviewNoteQuote(file, preferred.side, preferred.line, sourceTextForFile(file)),
  };
}

/**
 * Re-anchor stored notes after the document changed underneath them.
 *
 * Every quoted note gets a fresh verdict and a fresh anchor against the new document;
 * quoteless notes cannot re-anchor and are left exactly as they were. Returns the same
 * array when nothing changed, so observers can skip work with an identity check.
 */
export function reconcileReviewStoredNotes(
  entries: ReviewStoredNote[],
  files: readonly ReviewFileV1[],
  sourceTextForFile: (file: ReviewFileV1) => string | undefined,
): ReviewStoredNote[] {
  const quoted = entries.filter((entry) => entry.quote !== undefined);
  if (quoted.length === 0) {
    return entries;
  }

  const resolutions = resolveReviewNoteQuotes(
    quoted.map((entry) => entry.quote!),
    files,
    sourceTextForFile,
  );
  const byEntry = new Map(quoted.map((entry, index) => [entry, resolutions[index]!]));

  let changed = false;
  const next = entries.map((entry) => {
    const resolved = byEntry.get(entry);
    if (!resolved) {
      return entry;
    }

    const fileKey = resolved.fileKey ?? entry.note.fileKey;
    const anchor = resolved.placement?.anchor ?? entry.note.anchor;
    if (
      entry.resolution === resolved.resolution &&
      entry.note.fileKey === fileKey &&
      reviewAnchorsEqual(entry.note.anchor, anchor)
    ) {
      return entry;
    }

    changed = true;
    return {
      ...entry,
      resolution: resolved.resolution,
      note: { ...entry.note, fileKey, anchor },
    };
  });

  return changed ? next : entries;
}

/** Build the degenerate anchor an unplaceable restored note keeps its coordinates in. */
function unplacedAnchor(record: StoredNote): ReviewRangeAnchorV1 {
  const range: ReviewLineRange = [record.line, record.line];
  return {
    ...(record.side === "old" ? { oldRange: range } : { newRange: range }),
    preferred: { side: record.side, line: record.line },
    intersectingHunkIndices: [],
  };
}

/** Carry a persisted note's quote fields into the shape reconciliation reads. */
export function reviewNoteQuoteForStoredNote(record: StoredNote): ReviewNoteQuote {
  return {
    filePath: record.filePath,
    side: record.side,
    line: record.line,
    anchorText: record.anchorText,
    ...(record.prefixText !== undefined ? { prefixText: record.prefixText } : {}),
    ...(record.suffixText !== undefined ? { suffixText: record.suffixText } : {}),
  };
}

/**
 * Place persisted notes back into the review that is open now.
 *
 * Each record is resolved against the current document and becomes a stored note in the
 * collection its normalized source owns: the reviewer's notes stay editable, everything
 * else re-enters as a live note. An orphaned record still becomes an entry, because its
 * file may return on a later reconcile; it just renders nowhere until then.
 */
export function restoreReviewStoredNotes(
  records: readonly StoredNote[],
  files: readonly ReviewFileV1[],
  sourceTextForFile: (file: ReviewFileV1) => string | undefined,
): { live: ReviewStoredNote[]; user: ReviewStoredNote[] } {
  const quotes = records.map(reviewNoteQuoteForStoredNote);
  const resolutions = resolveReviewNoteQuotes(quotes, files, sourceTextForFile);

  const live: ReviewStoredNote[] = [];
  const user: ReviewStoredNote[] = [];
  records.forEach((record, index) => {
    const resolved = resolutions[index]!;
    const source = reviewNoteSourceFromStoredLabel(record.source);
    const entry: ReviewStoredNote = {
      note: {
        id: record.id,
        source,
        originalSource: record.source,
        fileKey: resolved.fileKey ?? "",
        anchor: resolved.placement?.anchor ?? unplacedAnchor(record),
        summary: record.summary,
        ...(record.rationale !== undefined ? { rationale: record.rationale } : {}),
        ...(source === "user" ? { author: "user" } : {}),
        createdAt: record.createdAt,
        editable: source === "user",
      },
      resolution: resolved.resolution,
      quote: quotes[index]!,
    };
    (source === "user" ? user : live).push(entry);
  });

  return { live, user };
}
