# Rebase onto upstream 0.19.0

Scope: one pass, no deferred follow-ups. Every item below lands before release.

Fork point: `cbd77c4890ee4a07bed679162f6dbc1bf6e34885` (upstream 0.18.0).
Ours: 15 commits. Upstream since the fork point: 44 commits, 522 changed files.

## 0. Target commit, and why it is not the tag

`v0.19.0` is `44e16f6d`. `upstream/main` is `f65c335e`, six commits ahead.

**Land on `upstream/main`, not on the tag.** Two of those six commits are load-bearing
for us:

- `823b14b6` (#790) adds `.dependency-cruiser.cjs`, `deps:check` as a required CI step
  in `ci.yml` and twice in `pr-ci.yml`, and a `.dependency-cruiser-known-violations.json`
  that is literally `[]`. Our fork has three import cycles today (phase 3). If we rebase
  onto the tag, this gate arrives two commits later and forces phase 3 to be redone.
  That is exactly the deferred follow-up the operator ruled out.
- `bf28a591` (#779) publishes `ctx.review.selection.currentLine`, which overlaps our
  click-to-move-cursor and jump-to-note work. Landing on the tag means resolving the same
  seam twice.

Cost of going to main: four website commits we do not ship and one validation refactor
(#778). Low.

Honest caveat: `upstream/main` is not a released version. The version string will say
`0.19.0` while describing a tree slightly ahead of it. Our existing tag convention
already handles this (`v0.18.0-ht.1` through `-ht.5`), so `v0.19.0-ht.1` is honest
provided the CHANGELOG names `f65c335e` explicitly.

## 1. Mechanic: replay onto a fresh branch. Not rebase, not merge.

```
git switch -c rebase/0.19 upstream/main
```

Then bring our work over deliberately, in the phase order below. Two moves do all the work:

```
git checkout main -- <path>              # for trees we added outright
git diff cbd77c48 main -- <path>         # to read our delta on a file upstream rewrote
```

**Why not `git rebase`.** Replaying 15 commits over a tree where their target files no
longer exist means resolving the same conflict repeatedly as later commits touch the same
files. `90abdd4e` alone touched 104 files. Worse, no intermediate commit would build, so
nothing verifies until the very end.

**Why not `git merge upstream/main`.** One conflict pass is better, but it produces a
single unreviewable commit, and git's rename detection threshold of 50% is the real
problem. Three renames fall at or below it:

| upstream rename                                                        | score               | consequence                                                                |
| ---------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------- |
| `src/session/app/registration.ts` -> `src/app/session/registration.ts` | R049                | not followed                                                               |
| `src/ui/hooks/useReviewController.ts` -> `useTerminalReview.ts`        | not a rename at all | upstream **deletes** the file; the test follows at R062, the impl does not |
| `src/core/loaders.ts` -> `src/core/changesetLoaders.ts`                | R057                | followed, barely                                                           |

A merge would silently auto-merge some files into the wrong shape and drop others as
modify/delete. Replay makes every one of those an explicit decision.

`main` stays untouched until the final land.

## 2. What we DELETE because upstream does it better

| we delete                                                                                                                                | upstream replacement                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/ui/lib/hunks.ts` + `hunks.test.ts`                                                                                                  | `src/core/review/navigation.ts`: `HunkCursor` -> `ReviewHunkCursor` (`:76`), `buildHunkCursors` -> `reviewStreamCursors` (`:125`), `buildAnnotatedHunkCursors` -> `reviewAnnotatedCursors` (`:135`), `findNextHunkCursor` -> `planReviewSelectionMove` (`:343`, broader contract). We never modified this file, so it costs only import rewiring. It is also tombstoned, so keeping it fails CI. |
| hand-built `oldRange`/`newRange` anchors, `src/ui/hooks/useReviewController.ts:960-1010`                                                 | `reviewLineAnchor(hunks, target)`, `src/core/review/anchors.ts`. This is what upstream's own `createVisibleAgentNote` already does.                                                                                                                                                                                                                                                              |
| unanchored-on-no-hunk degradation, `src/core/notes/session.ts:199-210` and `:266`, plus the comment asserting it as policy at `:174-176` | `reviewGapOwnerHunkIndex(hunks, side, line)`, `src/core/review/anchors.ts`. The note stays placed with empty `intersectingHunkIndices` and a fallback owner.                                                                                                                                                                                                                                     |
| `annotatedHunkLineTarget` as an independent policy, `src/ui/lib/agentAnnotations.ts:185-198`                                             | `resolveReviewRevealNoteId` (`src/core/review/selectors.ts`) plus `reviewNoteAnchorLine` (`src/core/review/state.ts:69`). See phase 5d for why leaving both is a live bug.                                                                                                                                                                                                                       |
| bespoke placeability predicate: `isPlaceableReviewNote`, `reviewNoteState`, `PLACEABLE_NOTE_STATES`, `agentAnnotations.ts:44-86`         | `reviewNoteVisibleByPolicy` (`state.ts:40`), `isRenderableStoredReviewNote` (`:28`), plus the note's `resolution`.                                                                                                                                                                                                                                                                               |
| `RestoredNoteResolution` as its own vocabulary, `src/core/liveComments.ts:8-22`                                                          | `ReviewNoteResolution = "active" \| "stale" \| "orphaned"`, `src/core/review/state.ts:16`.                                                                                                                                                                                                                                                                                                       |
| whatever in `src/ui/lib/reviewNotes.ts` (+261 lines) duplicates `src/ui/lib/reviewNoteMapping.ts`                                        | `storedNoteToLiveComment`, `storedNoteToUserNote`, `groupStoredNotesByFileId`.                                                                                                                                                                                                                                                                                                                   |
| our bail-out on sanitized lines, `src/ui/diff/pierre.ts:441-447`, and unsnapped UTF-16 slicing, `src/ui/diff/noveltySpans.ts:130-150`    | `rawOffsetToSanitizedOffset` + `snapToClusterBoundary`, `src/ui/diff/lineHighlightPaint.ts:64-97`. Both of ours are real bugs: one control character kills all novelty emphasis on a line, and a range boundary inside a grapheme cluster splits a glyph.                                                                                                                                        |
| our copies of `src/ui/lib/reviewState.ts` (+8/-1) and `src/ui/lib/files.ts` (unchanged)                                                  | take upstream's files whole; the symbols are tombstoned.                                                                                                                                                                                                                                                                                                                                         |
| three dead type aliases, `src/core/engine/difftastic/schema.ts:52-54`                                                                    | nothing. Knip flags them; they are unreferenced even in their own module.                                                                                                                                                                                                                                                                                                                        |
| `test/fixtures/difftastic/-0.69.0.json`                                                                                                  | nothing. It is a committed 0-byte file, a fixture recorded with an empty case name. Our own lint ignores hide it.                                                                                                                                                                                                                                                                                |
| `.changeset/{bundled-extensions-skill,heavy-moons-tell,preserve-captured-pager-color}.md`                                                | consumed into upstream's 0.19.0 CHANGELOG. Accept the deletion.                                                                                                                                                                                                                                                                                                                                  |

**Moved, not deleted:** our `RenderSpan.bold`, `RenderSpan.underline`, and
`SplitLineCell`/`StackLineCell.difftasticStyle` additions leave `pierre.ts` and land in
`src/ui/diff/diffRowModel.ts` (`:12`, `:18`, `:26`), where those three interfaces now live.

## 3. What we KEEP because upstream still lacks it

- **The whole difftastic engine**: `src/core/engine/difftastic/*` (12 files),
  `test/fixtures/difftastic/`, `docs/difftastic-engine.md`. Upstream has no structural
  engine. Pierre 1.3.5's similarity re-splitting is a different thing at a different layer.
- **The engine hook** `applyConfiguredEngine`, its fallback ladder, and its startup
  notices. Upstream's `loadAppBootstrap` (`changesetLoaders.ts:276`) still builds the
  changeset then returns `AppBootstrap`, so the seam survives intact.
- **difft-native rendering**: foreground colour on novel tokens, bold plus underline on
  the changed word, no backgrounds anywhere. This is a keep on a documented constraint,
  not a preference: difftastic leaves the whitespace _between_ its per-token spans in no
  span, so any painted background shows a hole at every gap
  (`src/ui/diff/noveltySpans.ts:33-44`). Upstream's `LineHighlightSpanStyle` is
  `{ bg, fg? }` (`lineHighlightPaint.ts:421`) and `paint()` always writes `bg`.
- **The two-tier novelty model** (novel token, then novel word on top inheriting the token
  foreground, `pierre.ts:450-462`). Upstream's cut plan resolves exactly one winning tone
  per column interval, so the tiers would collapse.
- **`src/core/notes/` textual re-anchoring** (`resolve.ts`, the four-rung ladder producing
  `anchored | moved | unanchored | orphaned`). Upstream declares the field and never
  implements the resolver. See 5e.
- **The all-notes sidebar**: `src/ui/components/panes/AllNotesPane.tsx`,
  `src/extensions/default/ui/notes/index.tsx`. Upstream ships only
  `["files", registerBundledSidebar]`. Nothing upstream can show a note that resolved to
  no line at all, and that is precisely what the sidebar is for.
- **The `hunkt` identity**: binary name, `HUNKT_*` env vars, config/state/daemon paths,
  `hunkt-*` skills.
- **`cursor_line` defaulting off**, so `j`/`k` scroll the viewport.
- **Click-to-move-cursor, menu dismissal on outside click, jump-to-note cursor
  placement**, subject to the `#779` overlap check in phase 6.
- **Our README** (303 lines against upstream's 6), `ACKNOWLEDGEMENTS.md`, the fork notice,
  our `LICENSE` change.
- **The nix flake and `nix/`.** Upstream has none.
- **`.oxfmtrc.json` / `.oxlintrc.json` `ignorePatterns` for `test/fixtures/difftastic`.**
  Load-bearing: without them lint-staged rewrites the recorded fixtures on commit.

## 4. Phases

### Phase 0. Preflight

- Cut `rebase/0.19` from `f65c335e`. Record the exact SHA in the CHANGELOG draft now, not
  at release time.
- Record `difft --version`. This box reports `Difftastic 0.69.0`, which matches every
  fixture name in `test/fixtures/difftastic/`. If it ever does not, the parity claim in V1
  is void and the fixtures must be re-recorded first.
- Work in a dedicated worktree so `main` is untouched.

**Proof:** `bun install` succeeds on the clean upstream tree; `bun run typecheck`,
`bun run lint`, `bun run deps:check`, `bun test scripts/source-boundaries.test.ts` all
green. This is the baseline. Anything red here is upstream's, not ours.

**Effort:** 1 hour.

### Phase 1. Toolchain, dependencies, gate wiring

Take upstream's `package.json` dependency block **wholesale**. It drops
`@hunk/session-broker-node` and `@types/shell-quote` (knip found them dead), bumps
`@opentui/core` and `@opentui/react` to `^0.5.1`, and `@pierre/diffs` to `1.3.5`.

Re-apply only our identity edits on top: `bin.hunkt` -> `./bin/hunk.cjs`, and the `files`
array listing the skills (four of them after phase 7, not two). Keep
`name: "hunkdiff"` as we do today.

OpenTUI 0.5.1 is **not a code change for us**. Everything our renderer touches is
byte-identical: `TextAttributes` (`types.d.ts:7-17`, same 9 members, `NONE`/`BOLD`/
`UNDERLINE` unchanged), `TextChunk` (`text-buffer.d.ts:6-15`), `SpanProps`, `MouseEvent`,
`StyledText`, `parseColor`, `createTextAttributes`, `RGBA`. The `@opentui/react` diff is
purely additive. So this is lockfile work only.

Also here:

- Regenerate `bun.lock` and `nix/bun.lock.nix`.
- Re-apply our `.oxfmtrc.json` and `.oxlintrc.json` fixture ignores.
- Mirror upstream's `deps:check` and `knip` scripts and their CI steps into our
  `ci.yml` / `pr-ci.yml`.

**Proof:** `bun install --frozen-lockfile`; `bun run typecheck`; `bun run deps:check`
still reports 0 on the still-clean tree.

**Effort:** 2 to 3 hours. Lockfile regeneration is the only unknown.

### Phase 2. Difftastic engine

Mechanically the cleanest of our work, so it lands first.

```
git checkout main -- src/core/engine/difftastic/ test/fixtures/difftastic/ docs/difftastic-engine.md
rm test/fixtures/difftastic/-0.69.0.json
```

Rewire imports onto the moved modules:

| old                                                                      | new                                                   |
| ------------------------------------------------------------------------ | ----------------------------------------------------- |
| `src/core/patch/normalize`                                               | `src/core/patch/sanitize`                             |
| `src/core/agent`                                                         | `src/core/sidecar`                                    |
| `src/core/hunkState`                                                     | `src/core/appStateFile`                               |
| `src/core/watch`, `watchController`, `watchObserver`, `watchPlan`        | `src/core/watch/{signature,controller,observer,plan}` |
| `src/core/{customThemes,themeCatalog,themeDetection,legacySyntaxScopes}` | `src/core/theme/*`                                    |
| `src/ui/lib/hunks`                                                       | `src/core/review/navigation`                          |

Then:

- Delete `DifftasticSideEntry`, `DifftasticChunkEntry`, `DifftasticAlignedRow`
  (`schema.ts:52-54`).
- Reattach the engine hook. Our `applyConfiguredEngine` (`src/core/loaders.ts:79`, called
  at `:559`) moves into `src/core/changesetLoaders.ts`, called from `loadAppBootstrap`
  (`:276`). Rename `src/core/loaders.engineDiagnostics.test.ts` ->
  `src/core/changesetLoaders.engineDiagnostics.test.ts`.
- Move the `--engine` flag and `engine` config key from `src/core/cli.ts` to
  `src/app/cli.ts`. `src/core/config.ts` and `src/core/types.ts` stay put but rebase onto
  upstream's +194-line `types.ts`.
- `src/core/startupNotice.ts` and its test land as-is.
- `src/core/engine/difftastic/applyEngine.integration.test.ts:5` imports `src/ui/lib/hunks`;
  point it at `src/core/review/navigation` with the renamed symbols.

**Proof:** `bun test src/core/engine/difftastic src/core/changesetLoaders.engineDiagnostics.test.ts`;
`bun run knip` shows no new unused exports; `bun run deps:check` still 0.

**Effort:** 4 to 6 hours.

### Phase 3. Cycle surgery. Lands with phase 2, not after.

`no-circular` is an error rule and the known-violations baseline is `[]`. There is no
place to park a cycle. Our fork has three.

1. `src/core/notes/types.ts:1` -> `src/core/liveComments.ts:2` -> `src/core/notes/resolve.ts:2`
   -> back. Closing edge is ours (`1fc33dee` added `import type { NoteResolutionState }`).
2. `src/core/types.ts:10` -> `src/core/notes/store.ts:5` -> `src/core/notes/types.ts:1` ->
   `src/core/liveComments.ts:3` -> back. Closing edge is ours
   (`import type { NoteScope }`, used once at `src/core/types.ts:446` for
   `AppBootstrap.noteScope`). `AppBootstrap` stays at `src/core/types.ts` upstream, so
   #790's own `core/types.ts` cleanup does not fix this for us.
3. `src/ui/diff/pierre.ts` -> `src/ui/diff/noveltySpans.ts:4` -> back.

Cuts:

- **Cycle 3 is free.** Point `noveltySpans.ts` at the leaf `src/ui/diff/diffRowModel.ts`
  for `RenderSpan`. Upstream created that module for exactly this class of back-edge; it
  is how they killed their own `pierre.ts` <-> `codeColumns.ts` cycle.
- **Cycles 1 and 2 need one deliberate cut.** Both close through
  `notes/types.ts -> liveComments.ts` for `DiffSide` (declared at `liveComments.ts:4`).
  Move `DiffSide` and `NoteScope` down into `src/core/notes/types.ts`, which then imports
  nothing. Re-export from `liveComments.ts` if the churn is not worth it, but the
  _declaration_ must move.

  **Open decision I could not settle read-only.** Upstream declares its own side
  vocabulary under `src/core/review/`. Before creating a third home for `"old" | "new"`,
  check whether `src/core/review/types.ts` should be the single declaration and `DiffSide`
  an alias of it. A duplicate side type is exactly what `EXTRACTED_DUPLICATE_SYMBOLS`
  exists to catch on the next audit.

Also enforce here: `src/core/notes/store.ts:1-3` uses `node:crypto` and `node:fs`.
`escapingImports(src/core/review, [src/core])` plus an empty node-debt map means nothing
under `src/core/review/` may value-import it. `resolve.ts` and `types.ts` are already
platform-free and stay importable.

**Proof:** `bun run deps:check` reports **0 violations and 0 cycles**. That is the whole
gate for this phase, and it is objective.

**Effort:** 2 to 3 hours, plus however long the `DiffSide` decision takes.

### Phase 4. Rendering on the new row model

- `src/ui/diff/pierre.ts` -> `src/ui/diff/diffRows.ts` (R067, so roughly a third of the
  file is new). Our +186/-18 rebases onto it.
- Move `RenderSpan.bold`, `RenderSpan.underline`, `SplitLineCell.difftasticStyle`,
  `StackLineCell.difftasticStyle` into `src/ui/diff/diffRowModel.ts` (`:12`, `:18`, `:26`).
- Our overlay call site gets simpler: upstream's `makeSplitCell` (`diffRows.ts:319`) and
  `makeStackCell` (`:373`) now converge all three highlight branches on one `spans`
  variable before returning, so `overlayCellNoveltySpans(...)` slots in once per function
  instead of three times.
- `src/ui/diff/renderRows.tsx` (+50/-11) and `src/ui/diff/rowStyle.ts` (+34/-7) rebase.
  **Invariant to preserve:** upstream deliberately runs `withRowLineHighlights`
  (`renderRows.tsx:1751`) and `applyLineHighlightsToSpans` (`:1815`) _outside_ the memoized
  row plan, and `DiffSectionBody.tsx:268-280` states that as the rule. That is correct for
  marks that change independently of geometry. Our novelty is a pure function of
  `(file, theme, tabWidth)` and must stay _inside_ the plan. Difftastic is our default
  engine; moving it out makes every changed row of every file pay on every render.
- Rename `src/ui/diff/PierreDiffView.emptyHunks.test.tsx` ->
  `src/ui/diff/DiffSectionBody.emptyHunks.test.tsx`.
- `src/ui/diff/staticDiffPager.ts` rebases.

**Adopt from upstream, both closing real holes:**

1. `rawOffsetToSanitizedOffset` and `snapToClusterBoundary`
   (`src/ui/diff/lineHighlightPaint.ts:64-97`). Export them from that module or lift them
   to a shared leaf, then call them from `overlayCellNoveltySpans` and
   `overlayNoveltySpans`. This deletes our whole-line bail-out and fixes glyph splitting.
2. The contrast machinery in `src/ui/diff/rowStyle.ts`: `contrastRatio`,
   `hexColorDistance`, `effectiveHighlightBackground` (`:228`). Today we apply
   `theme.addedSignColor` / `theme.removedSignColor` as the novel foreground with no
   contrast check against the cell's own `contentBg`. Run the same readability floor
   (`MIN_LINE_HIGHLIGHT_TEXT_CONTRAST = 3.1`, `rowStyle.ts:200`) over our foreground, and
   reuse `effectiveHighlightBackground` for the transparent-surface sentinel.

**Do NOT route novelty through `registerLineHighlighter`.** This is a decision, not a
deferred task. Four blockers, all concrete:

1. `LineHighlightSpanStyle` is `{ bg, fg? }` and `paint()` always writes `bg`. Our
   rendering is foreground plus bold plus underline with no background, for the
   whitespace-gap reason above.
2. The cut plan resolves one winning tone per column interval, so our word tier would
   _replace_ the token tier rather than stack on it.
3. `MAX_LINE_HIGHLIGHTS_PER_FILE = 2000` with whole-file drop on exceed is tuned for
   extensions, not for per-token novelty on every changed line times two tiers.
4. `useLineHighlights` publishes after an effect with a 1500 ms deadline. Every difftastic
   file would render its first frames bare and then flash.

**Free win to assert, not assume.** Our synthesized metadata already satisfies
`resolvePatchLines`'s contract: the mapper remaps difft's UTF-8 byte offsets to UTF-16
code units (`map.ts:111-123`, `:483-495`), and synthesized hunks carry
`additionStart = firstRow.newIndex + 1`, `additionLineIndex = firstRow.newIndex`
(`map.ts:662-670`). So upstream extension and agent line highlights should paint at the
right columns on difftastic-engine files. Pin that with a test.

**Pierre 1.3.5 behaviour change.** A change block with unequal addition/deletion counts is
now re-split by content similarity instead of paired by position. Our mapper is immune:
`map.ts:636-640` emits one-line change blocks only (`deletions: 0 | 1`, `additions: 0 | 1`).
The **git** engine's split-view alignment and word emphasis do change, which is upstream's
intent, and that will move expectations in our +556-line `pierre.test.ts` ->
`diffRows.test.ts`. Re-derive those expectations from the new library output. Do not force
the old numbers back.

**Proof:** `bun test src/ui/diff`; V1's visual parity check.

**Effort:** 6 to 8 hours.

### Phase 5. Review core adoption and note persistence. One commit. This is the phase.

Our note work **cannot be ported**, only re-implemented. Upstream deleted
`src/ui/hooks/useReviewController.ts` (1253 lines) and replaced it with
`src/ui/hooks/useTerminalReview.ts` (1487 lines), which projects
`projectReviewDocument(files, { sourceLabel })` (`:328`), owns a `createReviewStore`
(`:332`), funnels every mutation through `runIntent -> applyReviewIntent`, and reads notes
back out through `src/ui/lib/reviewNoteMapping.ts`. Notes, drafts and visibility are
store-resident.

**5a.** Land `src/core/notes/types.ts` and `resolve.ts` as-is (already platform-free).
Land `store.ts` and `session.ts` with the phase 3 cuts applied.

**5b.** Replace our anchor construction. `useReviewController.ts:960-1010` built
`oldRange`/`newRange` by hand. Our resolver now produces a `(side, line)` and hands it to
`reviewLineAnchor(file.metadata.hunks, target)` from `src/core/review/anchors.ts`, which
builds the `ReviewRangeAnchorV1`. Straight substitution; it is what upstream's own
`createVisibleAgentNote` already does.

**5c.** Drop our unanchored-on-no-hunk rule. `placementFor` (`session.ts:199-210`) returns
`undefined` when `findHunkIndexForLine < 0`, falling through to `{ state: "unanchored" }`
(`:266`). `reviewGapOwnerHunkIndex` is precisely the function that makes that degradation
unnecessary: first hunk starting after the line, else the last. Replace it, and rewrite the
comment at `session.ts:174-176`, which currently states the opposite as policy.

**5d.** Unify the two disagreeing reveal rules. Ours (`agentAnnotations.ts:185-198`): the
first annotation attached to the hunk owns the target, in file order. Theirs
(`resolveReviewRevealNoteId`, `src/core/review/selectors.ts`): an open draft wins,
otherwise the earliest anchor, arrival order breaking ties, and `DiffPane.tsx` scrolls to
that note. These pick different notes whenever a hunk's notes are not already in
anchor-line order, so our line cursor sits on note A while the viewport reveals note B.
Rewrite `annotatedHunkLineTarget` as a thin call to `resolveReviewRevealNoteId` plus
`reviewNoteAnchorLine` (`state.ts:69`). Three call sites follow: `moveToAnnotatedHunk`
(`useReviewController.ts:629`, now in `useTerminalReview`), `src/ui/lib/reviewState.ts:144`,
and `currentReviewNoteId` (`src/ui/lib/reviewNotes.ts:188-222`, whose own doc comment says
it deliberately mirrors `annotatedHunkLineTarget`).

**5e.** Fill upstream's vacant seat: wire re-anchoring to `document/reconcile`.

`ReviewNoteResolution = "active" | "stale" | "orphaned"` (`state.ts:16`) has three values
and only `"active"` is ever assigned (`intents.ts:439`, `liveCommentToStoredNote`).
`document/reconcile` (`reducer.ts:51-73`) retires expanded gaps and unattested source text
but never touches note anchors, while extension line highlights _are_ carried over
deliberately (`useTerminalReview.ts:373-380`, `carryOverLineHighlights`). So upstream today
lets a watch reload leave every note on a stale anchor while still reporting `"active"`.

Our re-anchoring is the implementation of that field:

- Add `notes/restore` and `notes/set-resolution` to `src/core/review/actions.ts`. Neither
  exists.
- Run the resolver on `document/reconcile`, not only at session start.
- Map our four states onto theirs: `anchored`/`moved` -> `"active"`, `unanchored` ->
  `"stale"`, `orphaned` -> `"orphaned"`.

**Hard constraint:** `src/core/review/**` must stay platform-free. `resolve.ts` and
`types.ts` are, so the reducer may import them. `store.ts` (`node:crypto`, `node:fs`) must
not be reachable from the reducer; persistence stays a `useTerminalReview` side effect.

**5f.** Fix the expanded-gap authoring bug in the same pass. `reviewSideLines`
(`session.ts:105-127`) only populates lines covered by `metadata.hunks`, so
`captureReviewNoteAnchor` (`:136-152`) returns `anchorText: ""` for a note authored on an
expanded gap line, and `resolve.ts:236-240` treats a blank anchor as unrecoverable. Such a
note reloads as `unanchored` forever. Line cursors do exist on expanded rows
(`src/ui/lib/lineCursors.ts:24-25`, `expandedGapKey`), so this is reachable today. Source
the lines from upstream's expansion model (`src/core/review/expansion.ts`) instead of from
hunk content.

**5g.** Satisfy `scripts/source-boundaries.test.ts`. Verified against our tree today, all
of these are live violations:

| file                                 | symbol                       | our state                                        |
| ------------------------------------ | ---------------------------- | ------------------------------------------------ |
| `src/ui/lib/hunks.ts`                | file tombstone (B1)          | exists; unchanged by us, so just do not carry it |
| `src/ui/lib/agentAnnotations.ts:64`  | `alwaysShowReviewNote`       | declared                                         |
| `src/ui/lib/agentAnnotations.ts:95`  | `annotationOverlapsHunk`     | declared, and **we modified it**                 |
| `src/ui/lib/agentAnnotations.ts:134` | `getAnnotatedHunkIndices`    | declared, and **we modified it**                 |
| `src/ui/lib/reviewState.ts:61`       | `resolveSelectedFile`        | declared; take upstream's file                   |
| `src/ui/lib/reviewState.ts:87`       | `findNextAnnotatedFile`      | declared; take upstream's file                   |
| `src/ui/lib/reviewState.ts`          | `buildReviewAnnotationIndex` | declared; take upstream's file                   |
| `src/ui/lib/files.ts:125`            | `filterReviewFiles`          | declared; unchanged by us                        |
| `src/core/liveComments.ts:63`        | `hunkLineRange`              | declared                                         |
| `src/core/liveComments.ts:94`        | `firstCommentTargetForHunk`  | declared                                         |

The test is a regex on `\b(?:function|const|let)\s+<symbol>\b` scoped to the named file, so
a re-export does not trip it. Re-declaring under the old name in the old file does. Our
`agentAnnotations.ts` placeability filter is the only one that needs real re-expression
(over `reviewNoteVisibleByPolicy` and `reviewNoteOwnerHunkIndex`); the rest resolve by
taking upstream's file.

**5h.** Our added UI rebases but keeps its shape:
`src/ui/components/panes/AllNotesPane.tsx` (+ test); `src/extensions/default/ui/notes/index.tsx`
registered alongside upstream's `["files", registerBundledSidebar]` in
`src/extensions/default/ui/index.ts` (note `getBundledUIRegistry` throws when
`registry.panes.length !== factories.length`, so the count check follows automatically);
`src/ui/lib/reviewNotes.ts` with its duplication against `reviewNoteMapping.ts` folded out;
`src/ui/AppHost.all-notes.test.tsx`. Rename
`src/ui/hooks/useReviewController.notes.test.tsx` -> `useTerminalReview.notes.test.tsx`.

**Proof:** `bun test src/core/review src/core/notes src/ui/lib src/ui/hooks`;
`bun test scripts/source-boundaries.test.ts` green (the objective gate);
`test/pty/notes.test.ts` green; and V2 below.

**Effort:** 2 to 3 days.

### Phase 6. Commands, keybindings, menus

- `src/ui/lib/appCommands.ts` splits. Upstream moved command **identity** (id, title,
  chords, `category`, `locus`) into `src/core/commandCatalog.ts` (608 lines; the type at
  `:58`, entries from `:97`). `appCommands.ts` keeps key matching and effect only.
- Every command we added declares an `AppCommandLocus` (`commandCatalog.ts:67`). Note
  authoring (`i`) is `semantic`. All-notes sidebar visibility (`a`) is `client-local`.
  `cursor_line` defaulting off is a config default, not a command.
- `src/ui/components/chrome/MenuScrim.tsx` stays put. It imports `MouseEvent` from
  `@opentui/core`, which is unchanged in 0.5.1.
- Click-to-move-cursor and jump-to-note placement rebase onto `src/ui/keyboardModes/` and
  onto `#779`'s `ctx.review.selection.currentLine`. **Check whether our click handler and
  their selected-line publication carry the same value.** If they do, publish once; two
  sources for one cursor is the shape upstream's audit list exists to catch.
- `src/ui/AppHost.menu-dismiss.test.tsx` and `src/ui/AppHost.line-scroll.test.tsx` rebase.
- `docs/keybindings.md` is generated: run `bun run generate:docs`, then `bun run check:docs`.

**Proof:** `bun test src/ui/lib/appCommands.test.ts src/ui src/core/commandCatalog*`;
`bun run check:docs` clean; V3 below.

**Effort:** 4 to 6 hours.

### Phase 7. The hunkt identity sweep

Our `90abdd4e` touched 104 files and **does not replay**. Upstream changed 522 files since
the fork point and every new one carries upstream naming. This is a fresh sweep.

Surfaces:

- `package.json`: `bin.hunkt`, and `files` listing all four skills.
- `HUNK_*` -> `HUNKT_*` across upstream files we have never seen, at minimum:
  `src/app/review/producer.ts`, `src/app/session/reviewCommands.ts`,
  `src/core/review/{intents,navigation,resourceAssembly,resources}.ts`,
  `src/core/vcs/index.ts`, `src/extensions/default/vcs/{git,jujutsu,sapling}/index.ts`,
  `scripts/review-vocabulary.test.ts`, plus everything we already handled.
- **Exception, do not rename:** `HUNK_EXTENSION_API_VERSION`
  (`src/extension-api/types.ts:24`, now `7`, was `4` at the fork point) and
  `HUNK_VENDOR_EXTENSION_ID`. Those are the third-party extension contract. Renaming them
  breaks every published extension for no gain. Write the exception into `docs/` so the
  next sweep does not undo it.
- Config, state and daemon paths; `HUNKT_INSTALL_SOURCE`.
- Skills: upstream now prefixes every skill `hunk-`. Full scope is **four**, not two:
  `skills/hunkt-review`, `skills/hunkt-extensions`, `skills/hunkt-launch-video` (upstream
  R087 renamed `skills/launch-video` -> `skills/hunk-launch-video`, which our fork left
  alone), and `skills/hunkt-release` (brand new upstream). Plus `src/hunk-review/` ->
  `src/hunkt-review/`.
- `scripts/generate-skill.ts`, `check-pack.ts`, `check-prebuilt-pack.ts`,
  `install-bin.ts`, `bin/hunk.cjs`.

Method: sweep by grep, then **verify by grep and read the output**. The check is
`git grep -nw 'hunk' -- src scripts bin packages test`, reviewed line by line for what
should stay: the extension API constants, upstream URLs, the `hunkdiff` package name, and
the word "hunk" as an ordinary diff term.

**Honest caveat:** I cannot tell read-only how many of the 522 upstream-changed files carry
a user-visible `hunk` string that matters. The count is the risk here, not the difficulty
of any single edit.

**Proof:** `bun test test/cli test/smoke`; `bun run check:pack`; `bun run generate:skill`
then `git status --porcelain` empty; a manual read of `hunkt --help`.

**Effort:** 1 day, dominated by verification rather than editing.

### Phase 8. Nix, docs, changesets

- `flake.nix` (`:60` `program = "${hunk}/bin/hunkt"`, `:84` `programs.hunkt.package`);
  `nix/package.nix` (`:30`, `:37`, `:41` the `hunkdiff` symlink, `:43`
  `HUNKT_INSTALL_SOURCE`, `:56` `mainProgram`); `nix/home-manager.nix`; `nix/devShell.nix`.
- Regenerate `nix/bun.lock.nix` for the 0.5.1 and 1.3.5 bumps.
- `difftastic` stays a **runtime dependency** of the wrapper (commit `e87787e5`), not
  bundled.
- Keep `README.md`, `ACKNOWLEDGEMENTS.md`, `docs/difftastic-engine.md`. **Rewrite
  `docs/note-persistence.md`** against the new model; 5b through 5f change what it
  describes, so leaving it is a doc that lies.
- Changesets: accept upstream's three deletions. Decide once whether our 12 stay individual
  or collapse into one fork changeset, and say which in the CHANGELOG.
- CHANGELOG records the upstream commit `f65c335e`, not just "0.19.0".

**Proof:** `nix build .#default`; `./result/bin/hunkt --version`; `bun run website:links`
if we keep the website tree.

**Effort:** 3 to 4 hours.

## 5. Verification

Nothing releases until all four groups pass. Run them in one session, on one tree.

### V1. Difftastic parity against the real binary

The binary is the only ground truth. `difft --version` on this box reports
`Difftastic 0.69.0`, matching every fixture name.

- **Re-record every `*-0.69.0.json` fixture from the installed binary and confirm the
  recapture is byte-identical to what is committed.** Any drift means a fixture was
  hand-edited at some point and the parity claim was never founded.
- Confirm the `.oxfmtrc.json` / `.oxlintrc.json` fixture ignores survived the rebase. Known
  trap: lint-staged rewrites these fixtures on commit, so the recapture check passes
  locally and then fails after the next commit.
- Side-by-side render on at least the whole `novel-*` set: `difft <before> <after>` against
  `hunkt --engine difftastic`. Three properties to check by eye: (a) the same tokens are
  marked novel, (b) the changed word carries bold plus underline, (c) no background is
  painted anywhere.
- New assertion earned by the rebase: an extension line highlight registered on a
  **difftastic-engine** file paints at the right columns. Our synthesized metadata claims
  to satisfy `resolvePatchLines`; pin it rather than assume it.
- `test/fixtures/difftastic/-0.69.0.json` is gone.

### V2. Note persistence across a real restart

Not a unit test. Drive the binary.

- Author notes in three positions: inside a hunk, on an **expanded gap line** (5f), and on
  a line that a later edit will move.
- Quit. Edit the file so anchors shift. Relaunch.
- Assert each note's `ReviewNoteResolution` _and_ its rendered position: the in-hunk note
  stays `"active"` on its moved line; the gap note survives at all (it does not today); a
  note whose text is gone reports `"orphaned"` and shows in the all-notes sidebar rather
  than beside unrelated code.
- **Repeat all three under a watch-triggered reload, not just a restart.** That is the
  `document/reconcile` path from 5e, the one upstream leaves unimplemented, so it has no
  upstream test to lean on. This is the check most likely to be waved through, and it is
  the one that catches the phase 5 failure mode.
- `test/pty/notes.test.ts` green.

### V3. Keybindings and menus, through a PTY

- `a` opens the all-notes sidebar; `i` opens an inline note; both with the assigned `locus`.
- `j`/`k` scroll the viewport with `cursor_line` off (our default), and move the cursor
  with it on.
- Click moves the cursor. Selecting a sidebar row places the cursor on that note's own
  anchor.
- A menu dismisses on an outside click.
- **The reveal check that proves 5d actually happened:** put two notes on one hunk in
  non-anchor order, then confirm the cursor and the revealed note are the _same_ note. If
  both rules are still present this is the only test that catches it.
- `bun run check:docs` clean, since `docs/keybindings.md` is generated.

### V4. Gates, all green in one run

1. `bun run typecheck`
2. `bun run lint`
3. `bun run deps:check` reporting **0 violations and 0 cycles**
4. `bun test scripts/source-boundaries.test.ts` (tombstones and banned symbols)
5. `bun run knip` with no new unused exports
6. `bun test` (full suite)
7. `bun test test/pty test/smoke`, including `test/smoke/tty.test.ts`
8. `bun run check:pack` and `bun run check:prebuilt-pack`
9. `nix build .#default` then `./result/bin/hunkt --version`

Step 7 matters more than usual this time: the OpenTUI 0.5.1 changeset claims runtime fixes
("faster FFI layout reads", "a fix for duplicate live frame timers") that typecheck cannot
see. A regression there surfaces only in the PTY and TTY suites.

## 6. Release

1. Land `rebase/0.19` on `main` with linear history. Squash or rebase, no merge commit.
2. Tag `v0.19.0-ht.1`, following the existing `v0.18.0-ht.N` convention. The CHANGELOG must
   name upstream `f65c335e`, because `0.19.0` alone misdescribes the tree.
3. Build and publish the release artifacts, so the brew formula has a real `url` and
   `sha256` to point at.
4. Update `Zamua/homebrew-tap` `Formula/hunktastic.rb`: `version`, `url`, `sha256`, and
   confirm the `test do` block still exercises `hunkt`. Update the tap `README.md` in the
   same change.
5. Nix: `nix/bun.lock.nix` regenerated; `nix/package.nix` takes its version from
   `package.json`; `difft` stays a runtime dependency of the wrapper.
6. **All four channels must agree on one version string before the release is done:** the
   git tag, `package.json` `version`, the brew formula `version` plus `sha256`, and the nix
   build's `--version` output. Check them together in one pass, not one at a time. A tap
   entry pointing at a stale asset installs the old build silently and reports success.
7. The tap install line only works if the source repo is public and the release asset is
   attached. Confirm both before claiming it works.

## 7. Effort

| phase                    | estimate                            |
| ------------------------ | ----------------------------------- |
| 0. preflight             | 1 h                                 |
| 1. deps and gates        | 2 to 3 h                            |
| 2. difftastic engine     | 4 to 6 h                            |
| 3. cycle surgery         | 2 to 3 h                            |
| 4. rendering             | 6 to 8 h                            |
| 5. review core and notes | 2 to 3 days                         |
| 6. commands and keybinds | 4 to 6 h                            |
| 7. hunkt sweep           | 1 day                               |
| 8. nix and docs          | 3 to 4 h                            |
| verification             | 4 to 6 h, plus whatever V2 turns up |

**Total: roughly 5 to 7 working days.**

## 8. The single biggest risk

**Phase 5.** Our note persistence was written against a hook upstream deleted, so the
correct rebase is a re-implementation, not a port. Worse, the field we are implementing
(`ReviewNoteResolution`) is declared upstream and never assigned anything but `"active"`.
We would be the first consumer of `"stale"` and `"orphaned"` and the first to make
`document/reconcile` touch note anchors. There is no upstream test to lean on and no
upstream behaviour to match, so a wrong reading of their intent surfaces only under V2's
watch-reload check.

The concrete failure mode: if `notes/set-resolution` lands as a `useTerminalReview` side
effect rather than a reducer action, every surface reading notes from the store sees
`"active"` forever. The feature silently reverts to what we have today while every unit
test stays green. V2's watch-reload leg is the only thing that catches it, which is exactly
why it must be run and read, not skipped as fiddly.

Two more worth naming:

- **Phase 7's surface is 522 changed files.** A missed `HUNK_` string is invisible until a
  user hits that code path. The mitigation is a grep, not a test, so it must be _read_, not
  just run.
- **The target-commit decision.** Landing on the `v0.19.0` tag to match the literal
  request means #790's empty dependency-cruiser baseline arrives two commits later and
  forces phase 3 to be redone. That is the deferred follow-up we were told not to create.

## 9. What I could not determine

Stated plainly, because these change the plan rather than decorate it.

- I could not run `bun install`, `tsc`, `depcruise`, `knip`, or any test. Every "green"
  above is a prediction to check, not an observation.
- Whether upstream's side vocabulary in `src/core/review/types.ts` should absorb our
  `DiffSide`. That changes the shape of phase 3's cut.
- How many of the 522 upstream-changed files carry a user-visible `hunk` string that must
  become `hunkt`.
- Whether OpenTUI 0.5.1's runtime changes regress anything. Type surface is identical; only
  the PTY and TTY suites can answer.
- Whether the operator wants our 12 changesets kept individually or collapsed into one.
