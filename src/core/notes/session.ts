/**
 * Bridge between the persisted note store and one live review.
 *
 * Re-anchoring itself is review-core work (`src/core/review/noteResolution.ts`, run by
 * the reducer on restore and reconcile). What remains here is the persistence seam: which
 * scope a review's notes live under, how the store's state maps back onto the persisted
 * record shape, and a writer that puts that shape on disk without blocking the caller.
 */
import { resolveCanonicalPath } from "../paths";
import type { ReviewState } from "../review/state";
import type { CliInput } from "../types";
import { writeNotes } from "./store";
import type { NoteScope, StoredNote } from "./types";

/**
 * Derive the scope a review persists notes under, or nothing when it has no
 * stable identity.
 *
 * The worktree root is the identity of the tree, and the review target keeps
 * notes taken over one revision from reappearing over another.
 */
export function resolveNoteScope(input: CliInput, repoRoot: string | undefined) {
  // A two-file compare names two arbitrary paths, and a patch names a stream:
  // neither identifies a tree that a later review could match, so both are
  // excluded here rather than falling through to an accidental scope.
  if (input.kind === "diff" || input.kind === "difftool" || input.kind === "patch") {
    return undefined;
  }

  if (!repoRoot) {
    return undefined;
  }

  return {
    worktreeRoot: resolveCanonicalPath(repoRoot),
    reviewTarget: reviewTargetKey(input),
  } satisfies NoteScope;
}

/** Name what a VCS-backed review is looking at, stably across sessions. */
function reviewTargetKey(input: Extract<CliInput, { kind: "vcs" | "show" | "stash-show" }>) {
  if (input.kind === "show") {
    return `show:${input.ref ?? "HEAD"}`;
  }

  if (input.kind === "stash-show") {
    return `stash-show:${input.ref ?? ""}`;
  }

  // Pathspecs deliberately stay out of the key: filtering a working-tree review
  // to a subdirectory is a view of the same tree, so its notes are the same notes.
  const parts = ["diff"];
  if (input.staged) {
    parts.push("staged");
  }
  if (input.range) {
    parts.push(input.range);
  }

  return parts.join(":");
}

/**
 * Map the store's mutable notes onto the records the persisted store writes.
 *
 * The quote carries the authored coordinates and text: stored coordinates are never
 * rewritten, so a note whose anchor moved is still written back exactly as it was
 * authored. A note no consumer captured a quote for has nothing to re-anchor by on a
 * later load and is not persisted.
 */
export function storedNotesForReviewState(
  state: Pick<ReviewState, "liveNotes" | "userNotes">,
): StoredNote[] {
  return [...state.liveNotes, ...state.userNotes].flatMap((entry) => {
    const quote = entry.quote;
    if (!quote) {
      return [];
    }

    return [
      {
        id: entry.note.id,
        filePath: quote.filePath,
        side: quote.side,
        line: quote.line,
        summary: entry.note.summary,
        ...(entry.note.rationale !== undefined ? { rationale: entry.note.rationale } : {}),
        source: entry.note.originalSource ?? entry.note.source,
        createdAt: entry.note.createdAt ?? "1970-01-01T00:00:00.000Z",
        anchorText: quote.anchorText,
        ...(quote.prefixText !== undefined ? { prefixText: quote.prefixText } : {}),
        ...(quote.suffixText !== undefined ? { suffixText: quote.suffixText } : {}),
      } satisfies StoredNote,
    ];
  });
}

export interface NoteStoreWriter {
  /** Replace what is pending; the whole set is written, so the last call wins. */
  save(notes: StoredNote[]): void;
  /** Write anything pending right now. */
  flush(): void;
  /** Write anything pending and stop accepting more. */
  dispose(): void;
}

export interface NoteStoreWriterOptions {
  write?: (scope: NoteScope, notes: StoredNote[]) => boolean;
  /** Defer one write off the caller's stack; tests run it inline. */
  schedule?: (task: () => void) => void;
  onFailure?: (message: string) => void;
}

/**
 * Persist one scope's notes without ever blocking the caller.
 *
 * Writes are deferred and coalesced: clearing a review replaces the whole set
 * many times in one tick, and only the final set is worth putting on disk. A
 * write that fails is reported and dropped, because a note store that cannot be
 * saved must not take the review down with it.
 */
export function createNoteStoreWriter(
  scope: NoteScope,
  { write = writeNotes, schedule, onFailure }: NoteStoreWriterOptions = {},
): NoteStoreWriter {
  const deferTask =
    schedule ??
    ((task: () => void) => {
      setTimeout(task, 0);
    });
  let pending: StoredNote[] | null = null;
  let scheduled = false;
  let disposed = false;

  const flush = () => {
    scheduled = false;
    const notes = pending;
    pending = null;
    if (!notes) {
      return;
    }

    if (!write(scope, notes)) {
      onFailure?.(`could not persist ${notes.length} review notes`);
    }
  };

  return {
    save(notes) {
      if (disposed) {
        return;
      }

      pending = notes;
      if (scheduled) {
        return;
      }

      scheduled = true;
      deferTask(flush);
    },
    flush,
    dispose() {
      flush();
      disposed = true;
    },
  };
}
