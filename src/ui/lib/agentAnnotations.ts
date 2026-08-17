import type { Hunk } from "@pierre/diffs";
import type {
  AgentAnnotation,
  DiffFile,
  ReviewNoteSource,
  UserNoteLineTarget,
} from "../../core/types";
import { reviewAnnotationOverlapsHunk } from "../../core/review/annotations";
import { resolveReviewNoteAnchor, reviewGapOwnerHunkIndex } from "../../core/review/anchors";
import type { ReviewHunkSpan } from "../../core/review/geometry";
import { resolveReviewRevealNoteId } from "../../core/review/selectors";
import {
  reviewNoteAnchorLine,
  reviewNoteOwnerHunkIndex,
  reviewNoteVisibleByPolicy,
} from "../../core/review/state";
import type { ReviewLineAddressV1, ReviewRangeAnchorV1 } from "../../core/review/types";
import { fileLabel } from "./files";

export interface VisibleAgentNote {
  id: string;
  annotation: AgentAnnotation;
  /**
   * Where this note hangs, as the shared resolver decided it: the owning hunk plus the
   * line the card sits beside. Render planning places the card from this and never from
   * range containment against the rows it happens to have drawn.
   */
  anchor: ReviewRangeAnchorV1;
  source?: ReviewNoteSource | "draft";
  editable?: boolean;
  draft?: {
    body: string;
    focused: boolean;
    onBlur?: () => void;
    onCancel: () => void;
    onFocus?: () => void;
    onInput: (value: string) => void;
    onSave: () => void;
  };
  onRemove?: () => void;
}

export interface AnnotationAnchor {
  side: "old" | "new";
  lineNumber: number;
}

/** Resolve the user-facing source for one inline note annotation. */
export function reviewNoteSource(annotation: AgentAnnotation): ReviewNoteSource {
  if (annotation.source === "user") {
    return "user";
  }

  if (annotation.source === "mcp" || annotation.source === "agent") {
    return "agent";
  }

  return "ai";
}

/** Return the annotations relevant to the currently selected hunk. */
export function getSelectedAnnotations(file: DiffFile | undefined, hunk: Hunk | undefined) {
  if (!file?.agent || !hunk) {
    return [];
  }

  return file.agent.annotations.filter((annotation) =>
    reviewAnnotationOverlapsHunk(annotation, hunk),
  );
}

/** Resolve the primary visual anchor for an annotation. */
export function annotationAnchor(annotation: AgentAnnotation): AnnotationAnchor | null {
  if (annotation.newRange) {
    return {
      side: "new",
      lineNumber: annotation.newRange[0],
    };
  }

  if (annotation.oldRange) {
    return {
      side: "old",
      lineNumber: annotation.oldRange[0],
    };
  }

  return null;
}

/** One note's declared target, from the surface that knows where the note was written. */
export interface VisibleNoteTarget extends ReviewLineAddressV1 {
  hunkIndex: number;
}

/**
 * Builds one note the review stream draws, resolving where it hangs through core.
 *
 * Every kind of note goes through here — sidecar annotations, agent live comments, the
 * reviewer's own notes, and the open draft — so ownership is decided once by the shared
 * resolver. A note that declares its target keeps it; one that only carries ranges hangs
 * from the line those ranges start at, and from the hunk owning the gap that line falls
 * in when no hunk contains it at all.
 */
export function createVisibleAgentNote(
  hunks: readonly ReviewHunkSpan[],
  note: Omit<VisibleAgentNote, "anchor"> & { target?: VisibleNoteTarget },
): VisibleAgentNote {
  const { target, ...visible } = note;
  const rangeAnchor = annotationAnchor(note.annotation);
  const preferred: ReviewLineAddressV1 | undefined = target
    ? { side: target.side, line: target.line }
    : rangeAnchor
      ? { side: rangeAnchor.side, line: rangeAnchor.lineNumber }
      : undefined;
  const fallbackOwnerHunkIndex =
    target?.hunkIndex ??
    (preferred ? reviewGapOwnerHunkIndex(hunks, preferred.side, preferred.line) : undefined);

  return {
    ...visible,
    anchor: resolveReviewNoteAnchor(hunks, {
      ...(note.annotation.oldRange ? { oldRange: note.annotation.oldRange } : {}),
      ...(note.annotation.newRange ? { newRange: note.annotation.newRange } : {}),
      ...(preferred ? { preferred } : {}),
      ...(fallbackOwnerHunkIndex !== undefined ? { fallbackOwnerHunkIndex } : {}),
    }),
  };
}

/**
 * Address one file's annotation as a note id.
 *
 * Explicit ids and synthesized index ids live in disjoint namespaces so an annotation
 * named "3" can never collide with an id-less annotation at index 3: reveal resolves
 * rows by this id, and a collision would aim it at the wrong note.
 */
export function reviewAnnotationNoteId(fileId: string, annotation: AgentAnnotation, index: number) {
  return annotation.id
    ? `annotation:${fileId}:id:${annotation.id}`
    : `annotation:${fileId}:at:${index}`;
}

/** The draft fields note placement reads, structurally satisfied by the pane's draft shape. */
export interface ReviewDraftNoteInput {
  id: string;
  hunkIndex: number;
  side: "old" | "new";
  line: number;
  oldRange?: [number, number];
  newRange?: [number, number];
  body: string;
}

/**
 * Resolve one file's notes to the placed shape every consumer reads.
 *
 * One pass over the merged annotation stream (sidecar annotations, agent comments, the
 * reviewer's notes, and the open draft), applying the shared visibility policy and the
 * shared anchor resolver, so the render plan, the reveal pick, and the current-line
 * placement all read the same decision about which notes exist and where each one hangs.
 * Interaction handlers are the caller's own and are attached on top of this list.
 */
export function resolveVisibleReviewNotes(
  file: DiffFile,
  options: { showAgentNotes: boolean; draft?: ReviewDraftNoteInput | null },
): VisibleAgentNote[] {
  const hunks = file.metadata.hunks;
  const notes = (file.agent?.annotations ?? [])
    .filter((annotation) =>
      reviewNoteVisibleByPolicy({ source: reviewNoteSource(annotation) }, options.showAgentNotes),
    )
    .map((annotation, index) => {
      const source = reviewNoteSource(annotation);
      const id = reviewAnnotationNoteId(file.id, annotation, index);
      if (source !== "user") {
        return createVisibleAgentNote(hunks, { id, annotation });
      }

      return createVisibleAgentNote(hunks, { id, annotation, source, editable: true });
    });

  const draft = options.draft;
  if (draft) {
    notes.push(
      createVisibleAgentNote(hunks, {
        id: draft.id,
        annotation: {
          id: draft.id,
          source: "user-draft",
          summary: draft.body || " ",
          oldRange: draft.oldRange,
          newRange: draft.newRange,
          editable: true,
        },
        // The draft knows exactly where the reviewer opened it, including on an expanded
        // gap line no hunk contains.
        target: { hunkIndex: draft.hunkIndex, side: draft.side, line: draft.line },
        source: "draft",
        editable: true,
      }),
    );
  }

  return notes;
}

/** The note one annotated-hunk jump reveals, plus the line the current line lands on. */
export interface AnnotatedHunkTarget {
  noteId: string;
  lineTarget: UserNoteLineTarget;
}

/**
 * Resolve the note a jump to one annotated hunk lands on.
 *
 * A thin call to the shared reveal policy: the winner is what `resolveReviewRevealNoteId`
 * picks among the hunk's own notes, and the line target is that winner's resolved anchor,
 * so the current line and the revealed note card always name the same note. A `preferred`
 * target overrides the policy when it matches an owned note's anchor exactly: a jump that
 * already chose a note (the all-notes list) must reveal that note, not the policy winner.
 * Null means the hunk renders no note, and plain hunk navigation keeps seeding the
 * current line from the hunk's first row.
 */
export function annotatedHunkLineTarget(
  notes: readonly Pick<VisibleAgentNote, "id" | "anchor" | "source">[],
  hunkIndex: number,
  preferred?: UserNoteLineTarget | null,
): AnnotatedHunkTarget | null {
  const owned = notes.filter((note) => reviewNoteOwnerHunkIndex(note) === hunkIndex);

  if (preferred) {
    const match = owned.find((note) => {
      const anchor = reviewNoteAnchorLine(note);
      return anchor.side === preferred.side && anchor.line === preferred.line;
    });
    if (match) {
      return { noteId: match.id, lineTarget: { side: preferred.side, line: preferred.line } };
    }
  }

  const revealNoteId = resolveReviewRevealNoteId(
    owned.map((note) => ({
      id: note.id,
      line: reviewNoteAnchorLine(note).line,
      draft: note.source === "draft",
    })),
  );
  const winner = owned.find((note) => note.id === revealNoteId);
  if (!winner) {
    return null;
  }

  const { side, line } = reviewNoteAnchorLine(winner);
  return { noteId: winner.id, lineTarget: { side, line } };
}

function formatGithubStyleRange(prefix: "L" | "R", range: [number, number]) {
  return range[0] === range[1]
    ? `${prefix}${range[0]}`
    : `${prefix}${range[0]}–${prefix}${range[1]}`;
}

/** Build a concise GitHub-style file-and-line label for inline note rows. */
export function annotationRangeLabel(annotation: AgentAnnotation, file?: DiffFile) {
  const locationParts: string[] = [];

  if (annotation.oldRange) {
    locationParts.push(formatGithubStyleRange("L", annotation.oldRange));
  }

  if (annotation.newRange) {
    locationParts.push(formatGithubStyleRange("R", annotation.newRange));
  }

  const location = locationParts.join(" → ") || "hunk";
  return file ? `${fileLabel(file)} ${location}` : location;
}
