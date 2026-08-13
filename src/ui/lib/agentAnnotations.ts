import type { Hunk } from "@pierre/diffs";
import type {
  AgentAnnotation,
  DiffFile,
  ReviewNoteSource,
  UserNoteLineTarget,
} from "../../core/types";
import { hunkLineRange, type RestoredNoteResolution } from "../../core/liveComments";
import type { NoteResolutionState } from "../../core/notes/resolve";
import { fileLabel } from "./files";

export interface VisibleAgentNote {
  id: string;
  annotation: AgentAnnotation;
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

/**
 * An annotation that may carry what note resolution decided about it.
 *
 * Only notes read back from the note store have the field; one authored in this
 * session is placed by construction. Structural, because the resolution rides on
 * the concrete note types while the review stream hands annotations around as
 * the base shape.
 */
export type ReviewNoteAnnotation = AgentAnnotation & { restored?: RestoredNoteResolution };

/** The two states whose notes name a line the current diff still renders. */
const PLACEABLE_NOTE_STATES: ReadonlySet<NoteResolutionState> = new Set<NoteResolutionState>([
  "anchored",
  "moved",
]);

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

/** Return whether a note should remain visible when the AI note layer is hidden. */
export function alwaysShowReviewNote(annotation: AgentAnnotation) {
  return reviewNoteSource(annotation) === "user";
}

/**
 * Resolve the state one note is in.
 *
 * A note with no recorded resolution is judged by its own coordinates, so notes
 * that never went through persistence behave exactly as they did before.
 */
export function reviewNoteState(annotation: ReviewNoteAnnotation): NoteResolutionState {
  if (annotation.restored) {
    return annotation.restored.state;
  }

  return annotationAnchor(annotation) ? "anchored" : "unanchored";
}

/** Report whether a note names a line this diff still renders. */
export function isPlaceableReviewNote(annotation: ReviewNoteAnnotation): boolean {
  return (
    PLACEABLE_NOTE_STATES.has(reviewNoteState(annotation)) && annotationAnchor(annotation) !== null
  );
}

/** Check whether two inclusive line ranges overlap. */
function overlap(rangeA: [number, number], rangeB: [number, number]) {
  return rangeA[0] <= rangeB[1] && rangeB[0] <= rangeA[1];
}

/** Check whether an annotation belongs to the visible span of a hunk. */
function annotationOverlapsHunk(annotation: AgentAnnotation, hunk: Hunk) {
  const hunkRange = hunkLineRange(hunk);

  if (annotation.newRange && overlap(annotation.newRange, hunkRange.newRange)) {
    return true;
  }

  if (annotation.oldRange && overlap(annotation.oldRange, hunkRange.oldRange)) {
    return true;
  }

  return false;
}

/** Return the annotations relevant to the currently selected hunk. */
export function getSelectedAnnotations(file: DiffFile | undefined, hunk: Hunk | undefined) {
  if (!file?.agent || !hunk) {
    return [];
  }

  // A note whose line the current diff no longer holds keeps its stored ranges, so overlap alone
  // would draw it beside code it is not about. The inline layer shows placeable notes only; the
  // all-notes list is where the rest stay visible.
  return file.agent.annotations.filter(
    (annotation) => isPlaceableReviewNote(annotation) && annotationOverlapsHunk(annotation, hunk),
  );
}

/**
 * Find the hunk one annotation belongs to, by the same overlap rule the inline layer uses.
 *
 * Null when no rendered hunk covers it, which is what an out-of-range note resolves to.
 */
export function hunkIndexForAnnotation(file: DiffFile, annotation: AgentAnnotation): number | null {
  const index = file.metadata.hunks.findIndex((hunk) => annotationOverlapsHunk(annotation, hunk));
  return index >= 0 ? index : null;
}

/** Mark which hunks in a file have any agent annotations attached. */
export function getAnnotatedHunkIndices(file: DiffFile | undefined) {
  const annotated = new Set<number>();
  if (!file?.agent) {
    return annotated;
  }

  file.metadata.hunks.forEach((hunk, index) => {
    if (
      file.agent?.annotations.some(
        (annotation) =>
          isPlaceableReviewNote(annotation) && annotationOverlapsHunk(annotation, hunk),
      )
    ) {
      annotated.add(index);
    }
  });

  return annotated;
}

/** Format an inclusive line range for note labels. */
function formatRange(range: [number, number]) {
  return range[0] === range[1] ? `${range[0]}` : `${range[0]}-${range[1]}`;
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

/**
 * Resolve the line a jump to one annotated hunk should land the current line on.
 *
 * Policy: the first annotation attached to the hunk owns the target, in the file order the review
 * stream already renders its notes in. Hunks with no anchorable annotation resolve to null so
 * plain hunk navigation keeps seeding the current line from the hunk's first row.
 */
export function annotatedHunkLineTarget(
  file: DiffFile | undefined,
  hunkIndex: number,
): UserNoteLineTarget | null {
  const hunk = file?.metadata.hunks[hunkIndex];
  for (const annotation of getSelectedAnnotations(file, hunk)) {
    const anchor = annotationAnchor(annotation);
    if (anchor) {
      return { side: anchor.side, line: anchor.lineNumber };
    }
  }

  return null;
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

/** Build the compact file-and-lines label shown on a framed agent note card. */
export function annotationLocationLabel(file: DiffFile, annotation: AgentAnnotation) {
  const locationParts: string[] = [];

  if (annotation.oldRange) {
    locationParts.push(`-${formatRange(annotation.oldRange)}`);
  }

  if (annotation.newRange) {
    locationParts.push(`+${formatRange(annotation.newRange)}`);
  }

  const location = locationParts.length > 0 ? ` ${locationParts.join(" ")}` : "";
  return `${fileLabel(file)}${location}`;
}
