# Note persistence

Live review notes survive quitting hunkt. On the next review of the same
worktree they re-anchor onto the current diff, and a note whose line no longer
exists degrades instead of disappearing.

Upstream hunk keeps live comments in memory only; quitting loses them
(modem-dev/hunk issue #113). The only file-backed path is `--agent-context`,
which runs the other way: an agent authors a file and hunkt reads it.

## 1. Where notes live

`<stateDir>/hunkt/notes/<scope-hash>.json`, where `stateDir` is
`$XDG_STATE_HOME` or `~/.local/state`. State, not config: the store grows
without bound, is machine-local, and is not hand-edited. Nothing is ever
written inside a repository.

The scope key is the **worktree root** plus the review target:

- Worktree root, not repo root. Two worktrees of one repo are separate
  reviews of separate trees, so a note taken in one must never surface in the
  other. `git rev-parse --show-toplevel` differs per worktree, while
  `--git-common-dir` is shared, so the toplevel is the identity.
- Review target distinguishes `hunkt diff` (working tree) from
  `hunkt show <rev>` or a range, so notes from reviewing an old commit do not
  reappear over uncommitted work.

The file name is a hash of that key; the key material is stored inside the
file so a human can tell what a given file belongs to. There is no index:
a directory listing is the index, and a second source of truth would drift
from the files it describes. Cleanup can drop any file whose worktree path no
longer exists.

Two-file reviews (`hunkt diff a.js b.js`) have no stable identity and are not
persisted in v1.

## 2. What a stored note carries

Persisting only `(file, side, line)` guarantees the notes break: line numbers
move on nearly every edit. Each note also stores the text it was written
against, which is what makes both re-anchoring and graceful degradation
possible.

```
{ id, filePath, side, line, summary, rationale?, source, createdAt,
  anchorText,        // the line the note pointed at, verbatim
  prefixText,        // up to 3 lines above
  suffixText }       // up to 3 lines below
```

`anchorText` doubles as the repair key and as the thing rendered when a note
can no longer be placed, so an orphaned note still reads as a statement about
known code rather than a dangling sentence. GitHub does the same by storing
`diff_hunk` alongside the comment.

Stored coordinates are never rewritten. The resolved position is computed at
load time, following Gerrit, which keeps the original comment and ports it on
read.

## 3. Resolution

Adapted from Gerrit's `GitPositionTransformer`, whose central idea is that a
comment is not "valid or dead" but _degrades in granularity_, and whose
conflict policy (`BestPositionOnConflict`) drops one level rather than
discarding the comment.

Each note resolves to one of:

| State        | Meaning                                                       | Inline?              |
| ------------ | ------------------------------------------------------------- | -------------------- |
| `anchored`   | Its line is present and the text still matches.               | yes                  |
| `moved`      | The line shifted; the text matches at the new line.           | yes, at the new line |
| `unanchored` | The line it described was itself edited, or the text is gone. | no                   |
| `orphaned`   | The file is gone from the review.                             | no                   |

Order of attempts:

1. **Shift the line through the diff.** Walk the edit list already computed
   for the file, accumulating `new_end - old_end` per edit that precedes the
   note. A note before every edit keeps its line; a note after them takes the
   full shift. This is exact, not probabilistic, and costs nothing extra
   because the diff exists. A note landing _inside_ an edited region is a
   conflict, and falls through.
2. **Confirm the text.** Compare `anchorText` against the file's content at
   the shifted line, ignoring leading whitespace: a reindent changes every
   line's bytes without changing its identity, which is exactly the case the
   difftastic engine treats as unchanged.
3. **Search for the text.** On mismatch, scan the file for
   `prefix + anchor + suffix`, then for `anchorText` alone. One hit re-anchors
   the note as `moved`. Several hits pick the one nearest the shifted line and
   mark lower confidence. This is the W3C Web Annotation model's
   TextQuoteSelector shape (exact plus prefix and suffix), which the standard
   recommends precisely because a position alone "is very brittle with regards
   to changes to the resource". The DOM implementations of it do not apply
   here, so the matcher is a small local function.
4. **Degrade.** No hit means `unanchored`: keep the note, keep its text, show
   it only in the notes list.

Fuzzy matching (Bitap, via the maintained `@sanity/diff-match-patch` fork) is
deliberately NOT used. Code is dense with near-identical lines (`}`,
`return err`), which is the input fuzzy matching is worst at, and it answers
"probably here" when the states above need "here or not".

## 4. Surfacing

- Inline: `anchored` and `moved` notes render as today, at their resolved line.
- `a` opens **All notes** for the review: a right sidebar, not a modal, so it
  stays open while moving through the diff, mirroring the existing left
  sidebar. Opening it reveals that pane alone, without pulling the file
  sidebar back on. Inline notes move to `i` to free `a`, and `n` stays unbound.
- The list is an index of the whole review, grouped by file in review order; a
  file with no notes contributes no group, and an orphan is grouped under the
  path it was stored against. `unanchored` and `orphaned` entries render dimmed
  with an explicit marker, and show their stored `anchorText` so the note
  still means something.
- Selecting a note jumps the diff to it and places the line cursor there,
  switching files first when the note belongs to another one. Notes with no
  position do not jump.
- View menu: "Agent notes" becomes "Inline notes"; "All notes" is added. The
  command id `hunk.view.toggleAgentNotes` keeps its name, because renaming a
  command id silently breaks any `[keybindings]` entry using it.

## 5. Testing

- Resolution is a pure function over (stored notes, diff, file contents), so
  the states are unit-testable without a TUI: unchanged file, edit above the
  note, edit below, reindent, the anchored line edited, the file deleted,
  duplicate anchor text.
- Round-trip: write notes, reload, assert positions and states.
- Scoping: two worktrees of one repo do not see each other's notes; a `show`
  review does not see working-tree notes.
- Store hygiene: nothing is written inside the repo, and a corrupt or
  unreadable store degrades to no notes rather than failing the review.
