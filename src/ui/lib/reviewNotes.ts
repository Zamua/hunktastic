import type { ResolvedReviewNote } from "../../core/notes/session";
import type { NoteResolutionState } from "../../core/notes/resolve";
import type {
  AgentAnnotation,
  DiffFile,
  ReviewNoteSource,
  UserNoteLineTarget,
} from "../../core/types";
import {
  annotationAnchor,
  hunkIndexForAnnotation,
  isPlaceableReviewNote,
  reviewNoteSource,
  reviewNoteState,
  type ReviewNoteAnnotation,
} from "./agentAnnotations";
import { fileLabel } from "./files";

/**
 * The all-notes list: what the review still knows about every note, including
 * the ones no line in this diff can carry.
 *
 * The list spans the whole review rather than the selected file, so it reads as
 * an index of the changeset instead of a second view of the file already on
 * screen. Groups follow review file order, and one row still names the file it
 * came from, which is what lets selecting a row cross a file boundary.
 *
 * Placed notes reach the review as annotations on their file, so they are read
 * from there and stay in file order. Notes that resolved to nowhere never enter
 * that map — there is no row to hang them on — so they are read from the
 * restored set instead and appended. That split is the whole reason this list
 * exists: it is the only surface where an unplaceable note is still visible.
 */

/**
 * Build the id the notes list and the jump agree on.
 *
 * Annotation ids are optional, so position within the file's own annotation
 * list is the fallback identity, matching how the session surface names notes
 * an agent never gave an id.
 */
export function reviewNoteId(fileId: string, annotation: AgentAnnotation, index: number): string {
  return annotation.id ?? `${fileId}#${index}`;
}

/** One row of the all-notes list. */
export interface ReviewNoteEntry {
  /** Stable across renders; also the id a jump names. */
  id: string;
  fileId: string;
  state: NoteResolutionState;
  /** True when selecting the entry can move the review. */
  placeable: boolean;
  source: ReviewNoteSource;
  summary: string;
  /** Present on unplaceable entries: the line the note was written against. */
  anchorText?: string;
  /** Short line reference, present only when the note has a resolved position. */
  location?: string;
}

/** Every note of one file, under the heading the list shows for it. */
export interface ReviewNoteGroup {
  /** The reviewed file's id; empty for notes whose file left the review. */
  fileId: string;
  /** Heading text: the file's review label, or an orphan's stored path. */
  label: string;
  entries: readonly ReviewNoteEntry[];
}

/** Read the one-line text an entry shows for a note. */
function entrySummary(summary: string | undefined, title?: string): string {
  const trimmed = summary?.trim();
  if (trimmed) {
    return trimmed.split("\n")[0] ?? trimmed;
  }

  return title?.trim() || "Note";
}

/** Format the resolved position of a placed note, GitHub-style. */
function entryLocation(annotation: AgentAnnotation): string | undefined {
  const anchor = annotationAnchor(annotation);
  return anchor ? `${anchor.side === "old" ? "L" : "R"}${anchor.lineNumber}` : undefined;
}

/** Report whether one restored note was stored against this file. */
function noteBelongsToFile(resolved: ResolvedReviewNote, file: DiffFile): boolean {
  return resolved.note.filePath === file.path || resolved.note.filePath === file.previousPath;
}

/** Turn one restored note with no place in the diff into a row. */
function unplaceableEntry(resolved: ResolvedReviewNote, fileId: string): ReviewNoteEntry {
  return {
    id: resolved.note.id,
    fileId,
    state: resolved.state,
    placeable: false,
    source: resolved.note.source === "user" ? "user" : "agent",
    summary: entrySummary(resolved.note.summary),
    anchorText: resolved.note.anchorText,
  };
}

/** List one reviewed file's notes: its placed annotations, then its stored strays. */
function fileNoteEntries(
  file: DiffFile,
  restoredNotes: readonly ResolvedReviewNote[],
): ReviewNoteEntry[] {
  const placed = (file.agent?.annotations ?? []).map(
    (annotation: ReviewNoteAnnotation, index): ReviewNoteEntry => {
      const placeable = isPlaceableReviewNote(annotation);
      return {
        id: reviewNoteId(file.id, annotation, index),
        fileId: file.id,
        state: reviewNoteState(annotation),
        placeable,
        source: reviewNoteSource(annotation),
        summary: entrySummary(annotation.summary, annotation.title),
        ...(placeable
          ? { location: entryLocation(annotation) }
          : { anchorText: annotation.restored?.anchorText }),
      };
    },
  );

  const unplaceable = restoredNotes
    .filter((resolved) => !resolved.placement && resolved.state !== "orphaned")
    .filter((resolved) => noteBelongsToFile(resolved, file))
    .map((resolved) => unplaceableEntry(resolved, file.id));

  return [...placed, ...unplaceable];
}

/**
 * Group every orphaned note under the path it was stored against.
 *
 * An orphan's file left the review entirely, so no reviewed file's group would
 * ever show it. Grouping by stored path keeps the note reachable and still says
 * which file it was about, in first-seen order.
 */
function orphanGroups(restoredNotes: readonly ResolvedReviewNote[]): ReviewNoteGroup[] {
  const byPath = new Map<string, ReviewNoteEntry[]>();

  for (const resolved of restoredNotes) {
    if (resolved.placement || resolved.state !== "orphaned") {
      continue;
    }

    const path = resolved.note.filePath;
    const entries = byPath.get(path) ?? [];
    entries.push(unplaceableEntry(resolved, ""));
    byPath.set(path, entries);
  }

  return Array.from(byPath, ([label, entries]) => ({ fileId: "", label, entries }));
}

export interface BuildReviewNoteGroupsOptions {
  /** The review's files, in review order. */
  files: readonly DiffFile[];
  /** Every stored note this review restored, with the state it resolved to. */
  restoredNotes?: readonly ResolvedReviewNote[];
}

/**
 * List every note in the review, grouped by the file it belongs to.
 *
 * A file with no notes contributes no group: the list is an index of what was
 * said, not a roster of the changeset.
 */
export function buildReviewNoteGroups({
  files,
  restoredNotes = [],
}: BuildReviewNoteGroupsOptions): ReviewNoteGroup[] {
  const groups: ReviewNoteGroup[] = [];

  for (const file of files) {
    const entries = fileNoteEntries(file, restoredNotes);
    if (entries.length > 0) {
      groups.push({ fileId: file.id, label: fileLabel(file), entries });
    }
  }

  return [...groups, ...orphanGroups(restoredNotes)];
}

/**
 * Name the one note the review is currently showing.
 *
 * Policy: the note anchored on the review's current line owns the selection, and the
 * first such note in file order wins when several share the line. That is the same
 * rule `annotatedHunkLineTarget` uses to place the current line when a jump lands on
 * an annotated hunk, so every way of reaching a note — a list row, note-to-note
 * stepping, the keyboard — highlights the row the review actually moved to, with no
 * second selection state to keep in sync.
 */
export function currentReviewNoteId(
  files: readonly DiffFile[],
  cursor: { fileId: string; target: UserNoteLineTarget } | null,
): string | null {
  if (!cursor) {
    return null;
  }

  const file = files.find((candidate) => candidate.id === cursor.fileId);
  if (!file?.agent) {
    return null;
  }

  const index = file.agent.annotations.findIndex((annotation: ReviewNoteAnnotation) => {
    if (!isPlaceableReviewNote(annotation)) {
      return false;
    }

    const anchor = annotationAnchor(annotation);
    return anchor?.side === cursor.target.side && anchor.lineNumber === cursor.target.line;
  });

  const annotation = file.agent.annotations[index];
  return annotation ? reviewNoteId(file.id, annotation, index) : null;
}

/** Where selecting one note should take the review. */
export interface ReviewNoteJumpTarget {
  hunkIndex: number;
  lineTarget: UserNoteLineTarget;
}

/**
 * Resolve the hunk and line one note selection should land on.
 *
 * Null means the note has nowhere to go — an unanchored or orphaned note, or
 * one whose anchor falls outside every hunk the review renders — so the caller
 * leaves the review where it is rather than jumping somewhere arbitrary.
 */
export function resolveReviewNoteJumpTarget(
  files: readonly DiffFile[],
  fileId: string,
  noteId: string,
): ReviewNoteJumpTarget | null {
  const file = files.find((candidate) => candidate.id === fileId);
  if (!file?.agent) {
    return null;
  }

  const annotation = file.agent.annotations.find(
    (candidate, index) => reviewNoteId(file.id, candidate, index) === noteId,
  );
  if (!annotation || !isPlaceableReviewNote(annotation)) {
    return null;
  }

  const anchor = annotationAnchor(annotation);
  const hunkIndex = hunkIndexForAnnotation(file, annotation);
  if (!anchor || hunkIndex === null) {
    return null;
  }

  return { hunkIndex, lineTarget: { side: anchor.side, line: anchor.lineNumber } };
}
