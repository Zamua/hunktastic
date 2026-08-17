import { NOTE_CONTEXT_LINES, type StoredNote } from "./types";

/**
 * How well a stored note still fits the file under review.
 *
 * A note is not valid or dead; it degrades in granularity. Losing a position
 * costs the note its inline placement, never the note itself.
 */
export type NoteResolutionState = "anchored" | "moved" | "unanchored" | "orphaned";

/**
 * The hunk facts the edit-list derivation reads.
 *
 * Structural so a parsed Pierre hunk and a projected `ReviewHunkV1` both
 * satisfy it without this module importing either model.
 */
export interface NoteResolutionHunk {
  additionStart: number;
  deletionStart: number;
  hunkContent: ReadonlyArray<{
    type: "context" | "change";
    lines?: number;
    additions?: number;
    deletions?: number;
  }>;
}

/** The stored fields the re-anchoring ladder reads from one note. */
export type NoteAnchorFields = Pick<
  StoredNote,
  "filePath" | "side" | "line" | "anchorText" | "prefixText" | "suffixText"
>;

/** One reviewed file, reduced to what note resolution reads from it. */
export interface NoteResolutionFile {
  path: string;
  /** Pre-rename path, so notes taken before a rename still find the file. */
  previousPath?: string;
  /** The file's diff hunks, in review order. */
  hunks: readonly NoteResolutionHunk[];
  /** Current new-side contents, one entry per line, without line terminators. */
  lines: string[];
}

export interface ResolvedNote<N extends NoteAnchorFields = StoredNote> {
  note: N;
  state: NoteResolutionState;
  /** New-side line the note renders at; absent when no position survived. */
  line?: number;
  /** Low when several identical anchors forced a nearest-hit pick. */
  confidence: "high" | "low";
}

/**
 * One region the diff replaced, as half-open line ranges on each side.
 *
 * An insertion has an empty old range and a deletion an empty new range, so one
 * shape covers every edit and an insertion point stays distinguishable from a
 * replaced line.
 */
export interface DiffEdit {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

/**
 * Derive the file's edit list from its hunks.
 *
 * Each hunk header fixes the first old and new line, and every `hunkContent`
 * entry then advances one or both sides by a known count, so the mapping is
 * exact rather than inferred. Hunks arrive in file order, which makes the
 * resulting edits ordered by `oldStart`.
 */
export function buildEditList(hunks: readonly NoteResolutionHunk[]): DiffEdit[] {
  const edits: DiffEdit[] = [];

  for (const hunk of hunks) {
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        oldLine += content.lines ?? 0;
        newLine += content.lines ?? 0;
        continue;
      }

      edits.push({
        oldStart: oldLine,
        oldEnd: oldLine + (content.deletions ?? 0),
        newStart: newLine,
        newEnd: newLine + (content.additions ?? 0),
      });
      oldLine += content.deletions ?? 0;
      newLine += content.additions ?? 0;
    }
  }

  return edits;
}

/**
 * Map one old-side line onto the new side through the edit list.
 *
 * Every edit that ends at or before the line contributes its length change, so
 * a note before all of them keeps its line and a note after all of them takes
 * the full shift. A line inside a replaced region has no mapped counterpart and
 * only gets a best guess for the text steps to confirm: an equal-length
 * replacement keeps its offset, which is what carries a reindent, and anything
 * else falls back to the start of the replacement.
 */
function shiftOldLine(line: number, edits: DiffEdit[]) {
  let delta = 0;

  for (const edit of edits) {
    if (edit.oldStart > line) {
      break;
    }

    if (edit.oldEnd <= line) {
      delta += edit.newEnd - edit.newStart - (edit.oldEnd - edit.oldStart);
      continue;
    }

    const sameLength = edit.oldEnd - edit.oldStart === edit.newEnd - edit.newStart;
    return sameLength ? edit.newStart + (line - edit.oldStart) : edit.newStart;
  }

  return line + delta;
}

/**
 * Strip leading whitespace before comparing two lines.
 *
 * A reindent changes every line's bytes without changing its identity, which is
 * exactly the change note text is meant to survive.
 */
function normalizeLine(line: string) {
  return line.trimStart();
}

/** Read one 1-based line, or nothing when it is outside the file. */
function lineAt(lines: string[], line: number) {
  return line >= 1 && line <= lines.length ? lines[line - 1] : undefined;
}

/** Split stored context text into lines, treating empty text as no context. */
function contextLines(text: string | undefined) {
  return text ? text.split("\n").map(normalizeLine) : [];
}

/** Split file contents into the line array resolution expects. */
export function splitLines(contents: string) {
  const lines = contents.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

/**
 * Capture the quote a note re-anchors by.
 *
 * The matcher owns this format, so notes are always written with the context
 * shape the search step later looks for.
 */
export function captureNoteAnchor(
  lines: string[],
  line: number,
): Pick<StoredNote, "anchorText" | "prefixText" | "suffixText"> {
  const index = line - 1;

  return {
    anchorText: lines[index] ?? "",
    prefixText: lines.slice(Math.max(0, index - NOTE_CONTEXT_LINES), index).join("\n"),
    suffixText: lines.slice(index + 1, index + 1 + NOTE_CONTEXT_LINES).join("\n"),
  };
}

/** Test one already-normalized run of lines against the file at a 1-based start. */
function matchesRun(lines: string[], start: number, run: string[]) {
  for (let offset = 0; offset < run.length; offset += 1) {
    const current = lineAt(lines, start + offset);
    if (current === undefined || normalizeLine(current) !== run[offset]) {
      return false;
    }
  }

  return true;
}

/** Collect every 1-based line where the quoted run places its anchor. */
function findAnchorLines(lines: string[], prefix: string[], anchor: string, suffix: string[]) {
  const run = [...prefix, anchor, ...suffix];
  const matches: number[] = [];

  for (let line = 1; line <= lines.length; line += 1) {
    if (matchesRun(lines, line - prefix.length, run)) {
      matches.push(line);
    }
  }

  return matches;
}

/** Pick the candidate closest to the shifted line, preferring the earlier one on a tie. */
function nearestLine(candidates: number[], target: number) {
  let best: number | undefined;
  for (const candidate of candidates) {
    if (best === undefined || Math.abs(candidate - target) < Math.abs(best - target)) {
      best = candidate;
    }
  }

  return best;
}

/** Find the reviewed file a note belongs to, following renames. */
function findFile(files: NoteResolutionFile[], filePath: string) {
  return files.find((file) => file.path === filePath || file.previousPath === filePath);
}

/**
 * Place one stored note against the file under review.
 *
 * The ladder drops one level at a time: shift the line through the diff,
 * confirm the anchor text there, search for the quoted run and then the anchor
 * alone, and finally keep the note without a position.
 */
function resolveNote<N extends NoteAnchorFields>(
  note: N,
  files: NoteResolutionFile[],
  editsFor: (file: NoteResolutionFile) => DiffEdit[],
): ResolvedNote<N> {
  const file = findFile(files, note.filePath);
  if (!file) {
    return { note, state: "orphaned", confidence: "high" };
  }

  // A new-side line is already a coordinate in the contents being resolved
  // against, so only the text steps below can repair it.
  const shifted = note.side === "old" ? shiftOldLine(note.line, editsFor(file)) : note.line;

  const anchor = normalizeLine(note.anchorText);
  const current = lineAt(file.lines, shifted);
  if (current !== undefined && normalizeLine(current) === anchor) {
    return {
      note,
      state: shifted === note.line ? "anchored" : "moved",
      line: shifted,
      confidence: "high",
    };
  }

  if (anchor.length === 0) {
    // A blank anchor matches every blank line, so searching for it would place
    // the note at an arbitrary one.
    return { note, state: "unanchored", confidence: "high" };
  }

  const prefix = contextLines(note.prefixText);
  const suffix = contextLines(note.suffixText);
  const quoted = prefix.length > 0 || suffix.length > 0;
  const matches = quoted ? findAnchorLines(file.lines, prefix, anchor, suffix) : [];
  const candidates = matches.length > 0 ? matches : findAnchorLines(file.lines, [], anchor, []);

  const line = nearestLine(candidates, shifted);
  if (line === undefined) {
    return { note, state: "unanchored", confidence: "high" };
  }

  return {
    note,
    state: line === note.line ? "anchored" : "moved",
    line,
    confidence: candidates.length > 1 ? "low" : "high",
  };
}

/**
 * Resolve stored notes against the current review.
 *
 * Pure: stored coordinates are never rewritten, so every load recomputes
 * positions from the diff and the file contents it was given.
 */
export function resolveNotes<N extends NoteAnchorFields>(
  notes: readonly N[],
  files: NoteResolutionFile[],
): ResolvedNote<N>[] {
  const editLists = new Map<NoteResolutionFile, DiffEdit[]>();
  const editsFor = (file: NoteResolutionFile) => {
    const cached = editLists.get(file);
    if (cached) {
      return cached;
    }

    const edits = buildEditList(file.hunks);
    editLists.set(file, edits);
    return edits;
  };

  return notes.map((note) => resolveNote(note, files, editsFor));
}
