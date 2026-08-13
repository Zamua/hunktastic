/**
 * Bridge between the persisted note store and one live review.
 *
 * The store and the resolver are pure over `(stored notes, hunks, lines)`. This
 * module is what turns a review into those inputs: it derives the scope a
 * review persists under, reads each reviewed file's per-side line corpus out of
 * the parsed diff, and places stored notes back onto the current changeset.
 */
import {
  findDiffFileByPath,
  findHunkIndexForLine,
  type DiffSide,
  type RestoredNoteResolution,
} from "../liveComments";
import { resolveCanonicalPath } from "../paths";
import type { CliInput, DiffFile } from "../types";
import {
  captureNoteAnchor,
  resolveNotes,
  type NoteResolutionFile,
  type NoteResolutionState,
} from "./resolve";
import { writeNotes, type NoteScope } from "./store";
import { NOTE_CONTEXT_LINES, type StoredNote } from "./types";

/** Where one restored note renders in the current review. */
export interface ReviewNotePlacement {
  fileId: string;
  filePath: string;
  hunkIndex: number;
  side: DiffSide;
  line: number;
}

/** One stored note placed against the review that is open now. */
export interface ResolvedReviewNote {
  note: StoredNote;
  state: NoteResolutionState;
  confidence: "high" | "low";
  /** Absent for `unanchored` and `orphaned` notes, which have nowhere to render inline. */
  placement?: ReviewNotePlacement;
}

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

/** Drop the line terminator the parsed diff keeps on each line. */
function stripLineTerminator(text: string) {
  return text.replace(/\r?\n$/, "");
}

/**
 * Read one side of a reviewed file as lines indexed by their own line number.
 *
 * Only the lines the diff covers are populated, so the array is sparse: a patch
 * carries the file's changed regions and their context, not the whole file, and
 * a note can only ever be authored on a row the diff renders. Reading a gap
 * yields `undefined`, which the matcher already treats as "no line here".
 */
export function reviewSideLines(file: DiffFile, side: DiffSide): string[] {
  const metadata = file.metadata;
  const source = side === "new" ? metadata.additionLines : metadata.deletionLines;
  const lines: string[] = [];

  for (const hunk of metadata.hunks) {
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

  return lines;
}

/**
 * Capture the quote one new note re-anchors by.
 *
 * The context window stops at the first gap in the corpus on each side, because
 * a quote spanning a line the diff never carried could not match anything on a
 * later load.
 */
export function captureReviewNoteAnchor(file: DiffFile, side: DiffSide, line: number) {
  const lines = reviewSideLines(file, side);

  let start = line;
  while (start > 1 && line - start < NOTE_CONTEXT_LINES && lines[start - 2] !== undefined) {
    start -= 1;
  }

  let end = line;
  while (end - line < NOTE_CONTEXT_LINES && lines[end] !== undefined) {
    end += 1;
  }

  // Slicing the contiguous run gives the matcher a dense window, so the captured
  // prefix and suffix are exactly the lines it will later compare.
  return captureNoteAnchor(lines.slice(start - 1, end), line - start + 1);
}

/** Build the resolver's view of one file from a corpus already derived for a side. */
function resolutionFile(file: DiffFile, lines: string[], hunks: DiffFile["metadata"]["hunks"]) {
  return {
    path: file.path,
    previousPath: file.previousPath,
    hunks,
    lines,
  } satisfies NoteResolutionFile;
}

/**
 * Place stored notes onto the review that is open now.
 *
 * A note is resolved against the side it was written on. New-side notes go
 * through the resolver's ladder against the current contents. Old-side notes
 * try the same ladder first, so a note on a line that survived the diff ports
 * forward exactly; a note on a line the diff removes has no counterpart there,
 * and falls back to the review's before-image, which is the coordinate space it
 * was authored in and where the diff still renders it.
 *
 * A resolved line outside every hunk cannot be rendered beside the code, so it
 * degrades to `unanchored` rather than claiming a placement the review cannot show.
 */
export function resolveStoredNotes(notes: StoredNote[], files: DiffFile[]): ResolvedReviewNote[] {
  const newSideFiles = new Map<DiffFile, NoteResolutionFile>();
  const oldSideFiles = new Map<DiffFile, NoteResolutionFile>();

  const sideFile = (file: DiffFile, side: DiffSide) => {
    const cache = side === "new" ? newSideFiles : oldSideFiles;
    const cached = cache.get(file);
    if (cached) {
      return cached;
    }

    // The before-image is the space an old-side line was written in, so no edit
    // list applies to it; an empty one is how that identity mapping is expressed.
    const entry = resolutionFile(
      file,
      reviewSideLines(file, side),
      side === "new" ? file.metadata.hunks : [],
    );
    cache.set(file, entry);
    return entry;
  };

  const placementFor = (file: DiffFile, side: DiffSide, line: number) => {
    const hunkIndex = findHunkIndexForLine(file, side, line);
    return hunkIndex < 0
      ? undefined
      : ({
          fileId: file.id,
          filePath: file.path,
          hunkIndex,
          side,
          line,
        } satisfies ReviewNotePlacement);
  };

  const resolveAgainst = (entries: Array<{ note: StoredNote; file: DiffFile }>, side: DiffSide) => {
    const resolutionFiles = entries.map((entry) => sideFile(entry.file, side));
    return resolveNotes(
      entries.map((entry) => entry.note),
      [...new Set(resolutionFiles)],
    );
  };

  const targets = notes.map((note) => ({
    note,
    file: findDiffFileByPath(files, note.filePath),
  }));
  const placeable = targets.filter(
    (target): target is { note: StoredNote; file: DiffFile } => target.file !== undefined,
  );
  const primary = new Map(
    resolveAgainst(placeable, "new").map((resolved) => [resolved.note, resolved]),
  );

  const fallbackTargets = placeable.filter((target) => {
    const resolved = primary.get(target.note);
    return (
      target.note.side === "old" &&
      (resolved?.line === undefined || !placementFor(target.file, "new", resolved.line))
    );
  });
  const fallback = new Map(
    resolveAgainst(fallbackTargets, "old").map((resolved) => [resolved.note, resolved]),
  );

  return targets.map(({ note, file }) => {
    if (!file) {
      return { note, state: "orphaned", confidence: "high" } satisfies ResolvedReviewNote;
    }

    for (const [side, resolved] of [
      ["new", primary.get(note)],
      ["old", fallback.get(note)],
    ] as const) {
      if (resolved?.line === undefined) {
        continue;
      }

      const placement = placementFor(file, side, resolved.line);
      if (placement) {
        return {
          note,
          state: resolved.state,
          confidence: resolved.confidence,
          placement,
        } satisfies ResolvedReviewNote;
      }
    }

    return { note, state: "unanchored", confidence: "high" } satisfies ResolvedReviewNote;
  });
}

/** Resolution metadata one restored note carries into the review. */
export function restoredResolution(resolved: ResolvedReviewNote): RestoredNoteResolution {
  return {
    state: resolved.state,
    confidence: resolved.confidence,
    anchorText: resolved.note.anchorText,
  };
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
