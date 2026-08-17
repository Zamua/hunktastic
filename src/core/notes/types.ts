/**
 * Which side of the diff a note's line coordinate addresses.
 *
 * Declared here, in a module that imports nothing, so both the live-comment
 * vocabulary and the persisted note shapes can name a side without an import
 * cycle through `liveComments`.
 */
export type DiffSide = "old" | "new";

/**
 * What one persisted note file belongs to.
 *
 * The worktree root is the identity, not the repository: two worktrees of one
 * repository are reviews of two different trees, and `--show-toplevel` differs
 * per worktree while `--git-common-dir` is shared. The review target keeps
 * notes taken over an old commit from reappearing over uncommitted work.
 */
export interface NoteScope {
  /** Absolute worktree root, canonicalized by the caller. */
  worktreeRoot: string;
  /** What is under review, e.g. `diff` for the working tree or a revision. */
  reviewTarget: string;
}

/**
 * Lines of surrounding context captured on each side of a note's anchor line.
 *
 * Enough to disambiguate a repeated line such as `}` or `return err`, few
 * enough that an unrelated edit nearby does not invalidate the whole quote.
 */
export const NOTE_CONTEXT_LINES = 3;

/**
 * One review note as it is persisted.
 *
 * Stored coordinates are never rewritten; the position a note renders at is
 * recomputed on every load (see `resolve.ts`). The text fields are what make
 * that possible: they re-anchor the note when lines move, and they are what the
 * notes list shows when no position survives, so an unplaceable note still
 * reads as a statement about known code.
 */
export interface StoredNote {
  id: string;
  /** Path as the review named it, matched against a file's current or previous path. */
  filePath: string;
  side: DiffSide;
  line: number;
  summary: string;
  rationale?: string;
  /** What authored the note, e.g. `mcp` for an agent-authored comment. */
  source: string;
  createdAt: string;
  /** The line the note pointed at, verbatim. */
  anchorText: string;
  /** Up to `NOTE_CONTEXT_LINES` lines above the anchor, newline joined. */
  prefixText?: string;
  /** Up to `NOTE_CONTEXT_LINES` lines below the anchor, newline joined. */
  suffixText?: string;
}
