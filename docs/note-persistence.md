# Note persistence

Review notes survive quitting hunkt. On the next review of the same worktree
they re-anchor onto the current diff, re-anchor again whenever the document
reloads underneath them, and degrade instead of disappearing when their line
is gone.

## Where notes live

`<stateDir>/hunkt/notes/<scope-hash>.json`, where `stateDir` is
`$XDG_STATE_HOME` or `~/.local/state` (`src/core/paths.ts`). State, not
config: the store grows without bound, is machine-local, and is not
hand-edited. Nothing is ever written inside a repository.

The scope key (`src/core/notes/session.ts`, `resolveNoteScope`) is the
**worktree root** plus the **review target**:

- Worktree root, not repo root: two worktrees of one repository are reviews
  of two different trees. `git rev-parse --show-toplevel` differs per
  worktree while `--git-common-dir` is shared, so the toplevel is the
  identity.
- The review target separates `hunkt diff` (working tree, with `staged` and
  range variants) from `hunkt show <rev>` and `stash show`, so notes taken
  over an old commit do not reappear over uncommitted work. Pathspecs stay
  out of the key: a filtered view of a tree is the same review.

Two-file compares, `difftool`, and `patch` input name no stable tree and are
not persisted.

The store (`src/core/notes/store.ts`) is fail-soft in both directions. Reads
treat a missing, unreadable, or damaged file as an empty one, and drop
individual entries that lost their shape. Writes stage a sibling temp file
and rename it into place, so a crash mid-write leaves the previous notes
intact; a write that cannot complete is reported and dropped rather than
failing the review.

## The quote model

Persisting only `(file, side, line)` guarantees breakage: line numbers move
on nearly every edit. Each `StoredNote` (`src/core/notes/types.ts`) also
carries the text it was written against:

- `anchorText`: the line the note pointed at, verbatim.
- `prefixText` / `suffixText`: up to `NOTE_CONTEXT_LINES` (3) lines of
  context on each side, newline joined.

The quote doubles as the repair key and as what the notes list shows when no
position survives, so an unplaceable note still reads as a statement about
known code. Stored coordinates are never rewritten: the rendered position is
recomputed on every load, and the note is written back exactly as authored.
A note with a blank `anchorText` cannot re-anchor, because a blank line
matches every blank line.

In the live review the same fields are a `ReviewNoteQuote`
(`src/core/review/state.ts`), captured the moment a note enters the store:
`notes/add-live` and `draft/save` both run `withReviewNoteQuote` against the
document the author was looking at. A note that arrives quoted keeps its
quote.

## The resolver ladder

`src/core/notes/resolve.ts` places one quote against one file in four rungs,
dropping one level at a time:

1. **Shift the line through the diff.** Walk the file's edit list, derived
   exactly from its hunks; a line before every edit keeps its number, a line
   after them takes the full shift. Exact, not probabilistic.
2. **Confirm the text.** Compare `anchorText` at the shifted line, ignoring
   leading whitespace: a reindent changes bytes without changing identity.
3. **Search for the text.** On mismatch, scan for `prefix + anchor +
suffix`, then for the anchor alone. Several hits pick the one nearest the
   shifted line and mark `confidence: "low"`.
4. **Degrade.** No hit means the note keeps its text but loses its position.

The verdicts are `anchored | moved | unanchored | orphaned` (orphaned means
the file is gone from the review). Fuzzy matching is deliberately absent:
code is dense with near-identical lines, and the ladder needs "here or not",
not "probably here".

`src/core/review/noteResolution.ts` maps those verdicts onto the review
core's `ReviewNoteResolution`: `anchored` and `moved` become `"active"`,
`unanchored` becomes `"stale"`, `orphaned` stays `"orphaned"`. New-side
quotes resolve against current contents; old-side quotes try that first and
fall back to the before-image they were authored in.

## When re-anchoring runs

Resolution is reducer work, so every consumer of the review store sees the
same verdicts:

- **Restore.** `useTerminalReview` reads the scope's records once and
  dispatches `notes/restore`; the reducer resolves each record against the
  current document and files it into the live or user collection by source.
- **Reconcile.** Every `document/reconcile` re-runs
  `reconcileReviewStoredNotes` over both collections, so a watch reload or
  soft reload that moved or deleted a noted line updates each note's
  resolution and anchor instead of leaving every note `"active"` on a stale
  anchor. An unchanged note keeps its identity, so observers can skip work.

Persistence stays a renderer side effect: `useTerminalReview` subscribes to
the store and mirrors every note change back to disk through a deferred,
coalescing writer (`createNoteStoreWriter`), serialized by
`storedNotesForReviewState` at the authored coordinates. The reducer and
`noteResolution.ts` are pure over `(quotes, files, loaded source text)`; the
persistence I/O lives in `src/core/notes/store.ts`, which no
`src/core/review/` module imports.

## Corpora and expanded gaps

`reviewNoteCorpus` builds the line array the matcher searches. Hunk-covered
lines come from the patch. A complete diff carries the whole file in its
side arrays. A partial file fills the collapsed gaps from loaded expansion
source text through each gap's range mapping, since gap rows are unchanged
context; lines nothing attests stay holes, which the matcher treats as
absent. Quote capture stops its context window at the first hole on each
side, so a quote never spans a line the review cannot vouch for.

This is what makes a note authored on an expanded gap line durable: its
quote is captured from the loaded source, carries real text, and re-anchors
on a later load like any other note.

## Degrade, never delete

Losing a position costs a note its inline placement, never the note itself:

- A quote whose text no longer matches anywhere stays placed at its stored
  coordinates and hangs from the gap-owner hunk
  (`reviewGapOwnerHunkIndex`), rendered as `"stale"`.
- Only a missing file orphans a note, and only a zero-hunk file leaves one
  without a placement.
- Orphaned entries stay in the store, because their file may return on a
  later reconcile; until then they render only in the all-notes pane
  (`AllNotesPane`), which shows the stored quote so the note still means
  something. Inline rendering hides only `"orphaned"` notes
  (`isRenderableStoredReviewNote`).
- The persisted record is never rewritten by resolution and never deleted by
  a failed placement; deleting a note is an explicit user action.
