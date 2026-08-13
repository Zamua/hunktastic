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

/**
 * The all-notes list: what the review still knows about every note, including
 * the ones no line in this diff can carry.
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

export interface BuildReviewNoteEntriesOptions {
  file: DiffFile | undefined;
  /** Every stored note this review restored, with the state it resolved to. */
  restoredNotes?: readonly ResolvedReviewNote[];
}

/**
 * List every note the reviewer should see while this file is selected.
 *
 * Three groups, in order: the file's placed notes, the notes stored against it
 * whose line is gone, and every orphaned note. Orphans are included on purpose
 * — their file left the review entirely, so no file's list would ever show them
 * and the note would be silently unreachable.
 */
export function buildReviewNoteEntries({
  file,
  restoredNotes = [],
}: BuildReviewNoteEntriesOptions): ReviewNoteEntry[] {
  if (!file) {
    return [];
  }

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
    .filter(
      (resolved) =>
        !resolved.placement && (resolved.state === "orphaned" || noteBelongsToFile(resolved, file)),
    )
    .map(
      (resolved): ReviewNoteEntry => ({
        id: resolved.note.id,
        fileId: file.id,
        state: resolved.state,
        placeable: false,
        source: resolved.note.source === "user" ? "user" : "agent",
        summary: entrySummary(resolved.note.summary),
        anchorText: resolved.note.anchorText,
      }),
    );

  return [...placed, ...unplaceable];
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
