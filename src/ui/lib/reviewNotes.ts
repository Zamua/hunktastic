import { resolveReviewRevealNoteId } from "../../core/review/selectors";
import {
  reviewNoteAnchorLine,
  reviewNoteOwnerHunkIndex,
  type ReviewNoteResolution,
  type ReviewStoredNote,
} from "../../core/review/state";
import type {
  AgentAnnotation,
  DiffFile,
  ReviewNoteSource,
  UserNoteLineTarget,
} from "../../core/types";
import { annotationAnchor, createVisibleAgentNote, reviewNoteSource } from "./agentAnnotations";
import { fileLabel } from "./files";

/**
 * The all-notes list: what the review still knows about every note, including
 * the ones no file in this diff can carry.
 *
 * The list spans the whole review rather than the selected file, so it reads as
 * an index of the changeset instead of a second view of the file already on
 * screen. Groups follow review file order, and one row still names the file it
 * came from, which is what lets selecting a row cross a file boundary.
 *
 * Placed notes reach the review as annotations on their file (the store's own
 * projection merges restored notes into that stream), so they are read from
 * there and stay in file order. An orphaned note's file left the review
 * entirely, so it never enters that stream; it is read from the store instead
 * and appended under the path it was stored against. That split is the whole
 * reason this list exists: it is the only surface where an orphaned note is
 * still visible.
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
  resolution: ReviewNoteResolution;
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

/** List one reviewed file's notes as rows, in the file's own annotation order. */
function fileNoteEntries(file: DiffFile): ReviewNoteEntry[] {
  return (file.agent?.annotations ?? []).map((annotation, index): ReviewNoteEntry => {
    // A rangeless annotation names no line at all, so its row cannot move the review.
    const placeable = annotationAnchor(annotation) !== null;
    return {
      id: reviewNoteId(file.id, annotation, index),
      fileId: file.id,
      resolution: placeable ? "active" : "stale",
      placeable,
      source: reviewNoteSource(annotation),
      summary: entrySummary(annotation.summary, annotation.title),
      ...(placeable ? { location: entryLocation(annotation) } : {}),
    };
  });
}

/**
 * Group every orphaned note under the path it was stored against.
 *
 * An orphan's file left the review entirely, so no reviewed file's group would
 * ever show it. Grouping by stored path keeps the note reachable and still says
 * which file it was about, in first-seen order.
 */
function orphanGroups(storedNotes: readonly ReviewStoredNote[]): ReviewNoteGroup[] {
  const byPath = new Map<string, ReviewNoteEntry[]>();

  for (const entry of storedNotes) {
    // Only a quoted note records the path it was stored against; a quoteless one
    // cannot become orphaned in the first place.
    if (entry.resolution !== "orphaned" || !entry.quote) {
      continue;
    }

    const entries = byPath.get(entry.quote.filePath) ?? [];
    entries.push({
      id: entry.note.id,
      fileId: "",
      resolution: "orphaned",
      placeable: false,
      source: entry.note.source,
      summary: entrySummary(entry.note.summary, entry.note.title),
      anchorText: entry.quote.anchorText,
    });
    byPath.set(entry.quote.filePath, entries);
  }

  return Array.from(byPath, ([label, entries]) => ({ fileId: "", label, entries }));
}

export interface BuildReviewNoteGroupsOptions {
  /** The review's files, in review order, with restored notes already merged in. */
  files: readonly DiffFile[];
  /** The store's mutable notes, read only for the orphans no file carries. */
  storedNotes?: readonly ReviewStoredNote[];
}

/**
 * List every note in the review, grouped by the file it belongs to.
 *
 * A file with no notes contributes no group: the list is an index of what was
 * said, not a roster of the changeset.
 */
export function buildReviewNoteGroups({
  files,
  storedNotes = [],
}: BuildReviewNoteGroupsOptions): ReviewNoteGroup[] {
  const groups: ReviewNoteGroup[] = [];

  for (const file of files) {
    const entries = fileNoteEntries(file);
    if (entries.length > 0) {
      groups.push({ fileId: file.id, label: fileLabel(file), entries });
    }
  }

  return [...groups, ...orphanGroups(storedNotes)];
}

/**
 * Name the one note the review is currently showing.
 *
 * The note anchored on the review's current line owns the selection, and the shared
 * reveal policy (`resolveReviewRevealNoteId`) breaks ties when several share the line:
 * the same rule `annotatedHunkLineTarget` places the current line by when a jump lands
 * on an annotated hunk. Every way of reaching a note (a list row, note-to-note
 * stepping, the keyboard) therefore highlights the row the review actually moved to,
 * with no second selection state to keep in sync.
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

  const candidates = file.agent.annotations.flatMap((annotation, index) => {
    const anchor = annotationAnchor(annotation);
    if (anchor?.side !== cursor.target.side || anchor.lineNumber !== cursor.target.line) {
      return [];
    }

    return [{ id: reviewNoteId(file.id, annotation, index), line: anchor.lineNumber }];
  });

  return resolveReviewRevealNoteId(candidates) ?? null;
}

/** Where selecting one note should take the review. */
export interface ReviewNoteJumpTarget {
  hunkIndex: number;
  lineTarget: UserNoteLineTarget;
}

/**
 * Resolve the hunk and line one note selection should land on.
 *
 * Placement goes through the shared anchor resolver, so the jump lands exactly where
 * the inline card hangs, including a note outside every hunk, which hangs from its
 * gap-owner hunk. Null means the note names no line at all (a rangeless annotation,
 * or an id nothing carries), so the caller leaves the review where it is rather than
 * jumping somewhere arbitrary.
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
  if (!annotation || annotationAnchor(annotation) === null) {
    return null;
  }

  const placed = createVisibleAgentNote(file.metadata.hunks, { id: noteId, annotation });
  const { side, line } = reviewNoteAnchorLine(placed);
  return { hunkIndex: reviewNoteOwnerHunkIndex(placed), lineTarget: { side, line } };
}
