# difftastic engine

Structural diffs (difftastic) as a second, opt-in diff engine under hunk's
review TUI and agent annotation flow. Default engine stays `pierre`.

difftastic is consumed as a subprocess (`difft --display json`, gated by
`DFT_UNSTABLE=yes`). The JSON schema is explicitly unstable. Pin the tested
binary version, validate every payload defensively, and fall back to the
existing Pierre path on any doubt. The engine must never crash the app and
never produce a silently wrong diff: every fallback is visible.

Tested against difftastic 0.69.0. Ground-truth fixture:
`test/fixtures/difftastic/` (see Testing).

## 1. Scope

### v1 in scope

- Structural rendering for the two-file flow (`hunkt diff A B`, `difftool`)
  and the git-backed flows (`hunkt diff` working tree, `show`, `stash-show`)
  in the review stream.
- `[` / `]` hunk navigation over structural chunks (difftastic chunks become
  `metadata.hunks`; all existing cursor machinery works unchanged).
- Agent comments: `hunkt session comment add` with `--hunk/hunkNumber`,
  `--old-line`, `--new-line` anchors resolving against structural hunks.
- Split and stack layouts, including difftastic's explicit lhs/rhs row
  alignment in split view.
- Intraline novelty spans from difftastic's per-line column ranges, rendered
  with difft's own novel-token foreground (section 5.5).
- Word-level novelty emphasis: difftastic's two-tier novelty decision, ported
  and re-run over the payload's own spans, rendered bold plus underline
  (section 5.6).

### v1 out of scope (explicit)

- difftastic for `patch` and `pager` inputs (no file contents available;
  Pierre always, one notice if `engine = "difftastic"` is configured).
- Watch-mode performance edge cases. Watch re-runs the full load pipeline;
  if per-file difft spawns make watch sluggish, watch keeps difftastic but a
  content-hash spawn cache is a follow-up, not a v1 blocker.
- npm publishing of any of this.
- Tuning difft limits (`--graph-limit`, `--byte-limit`,
  `--parse-error-limit`). v1 runs difft defaults; difft's internal
  line-oriented fallback output is accepted as-is.

## 2. Engine selection surface

New option `engine`, values `"pierre" | "difftastic"`. Layered exactly like
existing view options. Precedence (low to high): built-in default
-> user config TOML -> repo `.hunkt/config.toml` -> `HUNKT_ENGINE` env ->
`--engine` CLI flag.

The built-in default is `difftastic` (`DEFAULT_DIFF_ENGINE` in
`src/core/types.ts`): structural diffs are what this fork exists for, so they
are on unless a layer above turns them off. A missing difft therefore surfaces
the unavailable notice on a default run rather than only when opted in.

Novelty rendering has no option. difftastic's own foreground-only marking is the
one rendering path, for the reason section 5.5 gives, so there is nothing to
select between.

Touch list (mirrors the `layout` option shape):

- `src/core/types.ts` — add `engine?: DiffEngineId` to `CommonOptions`;
  export `type DiffEngineId = "pierre" | "difftastic"`.
- `src/core/cli.ts` — add `{ flag: "--engine <engine>" }` to
  `COMMON_REVIEW_OPTIONS` (auto-registers on every `commonReviewOptions`
  command); add `parseEngine` validator next to `parseLayoutMode`
  (closed enum, reject unknown values at parse time); wire in
  `applyReferenceOption`; thread through `buildCommonOptions`; add the flag
  line to the hand-written `renderCliHelp`.
- `src/core/config.ts` — add `CONFIG_REFERENCE_OPTIONS` entry
  (`key: "engine"`, `runtimeDefault: "pierre"`); add an explicit string case
  in `normalizeConfigReferenceValue` (the default branch is
  `normalizeBoolean` and silently drops string keys); add
  `engine: overrides.engine ?? base.engine` to `mergeOptions`; apply
  `HUNKT_ENGINE` (validated, invalid value ignored with a notice) in
  `resolveConfiguredCliInput` after the repo layer and before CLI-flag merge;
  final default fill `engine: resolvedOptions.engine ?? "pierre"`.
- `src/core/config.ts` — second key `difft_path` (binary path override).
  Honored from user config and `HUNKT_DIFFT_PATH` env only; a repo-config
  value is IGNORED with the existing exec-adjacent repo-config notice
  treatment (`createRepoExtensionConfigNotice` precedent). Default `"difft"`
  (PATH lookup).
- Regenerate docs: `bun run generate:docs`
  (`scripts/generate-docs.test.ts` asserts every runtime key renders).

`HUNKT_ENGINE` is the test hook: PTY/CLI tests set it instead of threading
flags. It deliberately sits below the CLI flag so an explicit `--engine`
always wins.

Reloads are covered for free: `performReloadSession` re-runs
`resolveRuntimeCliInput` -> `resolveConfiguredCliInput`, and
`withCurrentViewOptions` preserves `engine` across refresh.

## 3. Subprocess layer

New core module `src/core/engine/difftastic/` (this is a core engine, not an
extension: the extension API has no engine registration surface and VCS
adapters emit patch text that core always parses with Pierre).

- `src/core/engine/difftastic/exec.ts` — spawn wrapper. Copy the
  `runGitCommand` shape (`src/extensions/default/vcs/git/commands.ts`):
  `Bun.spawnSync([difftPath, ...args], { stdin: "ignore", stdout: "pipe",
stderr: "pipe", env, timeout })`, exit-code allowlist `[0]`, spawn-throw
  translated to a typed missing-binary result (match Bun's
  "Executable not found in $PATH").
- Every invocation sets `DFT_UNSTABLE: "yes"` in env.
- Version detection: `difft --version` once per process, cached in module
  state. Parse `Difftastic X.Y.Z`. Unparseable output = missing binary.
  Record the version; no minimum enforced in v1, but the schema validator is
  the real gate (see below).
- Per-file invocation with explicit paths:
  `difft --display json <beforePath> <afterPath>`. No context flag: JSON
  chunks carry only novel lines; context is reconstructed from file bodies.
- Timeout: 5000 ms per file. Timeout or kill -> per-file fallback.
- Input materialization (`materialize.ts`): the two-file flow passes the real
  paths directly. Git-backed flows fetch both sides via the file's
  `sourceFetcher.getFullText("old" | "new")` (`src/core/fileSource.ts`) and
  write them to `<os.tmpdir()>/hunk-difft-<pid>/<n>/{old,new}/<basename>`,
  preserving the basename so difft's extension-based language detection
  works. Delete the tree in `finally`. A `null` fetch or the
  `DEFAULT_SOURCE_TEXT_MAX_BYTES` cap exceeded -> per-file fallback.
- `schema.ts` — zod schema (zod is already a dependency) for the per-file
  object: `{ aligned_lines: [number|null, number|null][], chunks:
ChunkEntry[][], language: string, path: string, status: string }`,
  `ChunkEntry = { lhs?: SideEntry, rhs?: SideEntry }`, `SideEntry =
{ line_number: number, changes: { start: number, end: number,
content: string, highlight: string }[] }`. Unknown top-level keys are
  allowed (schema is unstable); missing/mistyped required keys fail
  validation -> per-file fallback.

### Fallback ladder

| Condition                                                                                                    | Behavior                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binary missing / version probe fails                                                                         | Whole changeset renders via Pierre. One startup notice via the existing `bootstrap.startupNotices` mechanism (`src/app/startup.ts:342`, rendered by `AppHost`): `difftastic engine unavailable (difft not found); using pierre`. |
| difft nonzero exit / timeout for a file                                                                      | Pierre for that file.                                                                                                                                                                                                            |
| JSON parse or schema validation failure                                                                      | Pierre for that file.                                                                                                                                                                                                            |
| Mapper validation failure (non-monotonic `aligned_lines`, line numbers out of file bounds, unknown `status`) | Pierre for that file.                                                                                                                                                                                                            |
| Source text unavailable / over size cap                                                                      | Pierre for that file.                                                                                                                                                                                                            |
| Binary file (`DiffFile.isBinary`)                                                                            | Never sent to difft; existing binary rendering.                                                                                                                                                                                  |
| `patch` / `pager` input kind                                                                                 | Pierre always; one notice if difftastic was configured.                                                                                                                                                                          |

Per-file fallbacks are aggregated into one startup notice
(`difftastic fell back to pierre for N file(s)`); details go to `log`
diagnostics, not the UI. `DiffFile` gains `engine: DiffEngineId` so the UI
and the session protocol can report which engine produced each file.

## 4. Engine dispatch point

All computation stays at load time inside `loadAppBootstrap`
(`src/core/loaders.ts`); render never re-diffs.

Difftastic is an OVERLAY on the existing pipeline, not a replacement parser:

1. Run the existing path first. Git-backed modes: git patch text ->
   `normalizePatchChangeset` -> Pierre `parsePatchFiles` -> `buildDiffFile`.
   Two-file mode: `loadFileDiffChangeset` -> Pierre `parseDiffFromFile`.
   This yields the file list, paths, rename detection, binary sniff,
   `DiffFile.patch` chunks, and a complete Pierre metadata to fall back to
   per file.
2. If `engine === "difftastic"`, call
   `applyDifftasticEngine(changeset, opts)`
   (`src/core/engine/difftastic/index.ts`) before `orderDiffFiles`. For each
   eligible file (not binary, not too large, status-eligible) it obtains
   both bodies, runs difft, maps the JSON, and REPLACES
   `file.metadata.hunks` + the flat line arrays (see Mapping), sets
   `file.engine = "difftastic"`, recomputes `file.stats` from the mapped
   hunks (so header counts match rendered rows), and attaches the intraline
   sidecar. Any failure leaves the Pierre metadata untouched and records the
   fallback.
3. Skip difft for `ChangeTypes` `new` / `deleted` files: a pure
   creation/deletion has no structural alignment to compute; Pierre's
   all-addition/all-deletion hunk is already correct.

The two-file flow already holds both bodies in memory
(`loaders.ts` reads them for `parseDiffFromFile`); pass them straight to the
mapper without re-reading. Git-backed flows use the per-file
`sourceFetcher`, which is attached by `buildDiffFile` before the overlay
runs.

## 5. Mapping layer: difftastic JSON -> Pierre model

Module `src/core/engine/difftastic/map.ts`. Pure function:

```
mapDifftasticFile(json, oldText, newText, options) -> {
  hunks: Hunk[],
  deletionLines: string[],   // full old file
  additionLines: string[],   // full new file
  noveltySpans: DiffLineNoveltySpans,
  changeType: ChangeTypes,
} | { fallback: reason }
```

### 5.1 Ground truth from the sample (difftastic 0.69.0)

Fixture: `DFT_UNSTABLE=yes difft --display json before.js after.js`.
Two facts the mapper MUST honor (both are traps for a chunks-only reader):

- An added/deleted line with no novel token content (e.g. an inserted blank
  line) appears in `aligned_lines` as `[null, n]` / `[n, null]` but has NO
  chunk entry at all (sample: rhs line 7). Novelty by position must be
  derived from `aligned_lines`, not from `chunks`.
- A chunk entry can list a side with an EMPTY `changes` array (sample: lhs
  line 0, paired with a rhs line that gained tokens). The line pair is still
  a modification; the empty side simply has zero novel spans.

`highlight` on a change span is a syntax kind
(`normal|string|keyword|type|comment|delimiter|tree_sitter_error`), not
novelty emphasis. Every span listed in `changes` IS novel (only novel spans
are emitted); `highlight` is ignored by the mapper (Shiki already owns
syntax color). `start`/`end` are 0-based, end-exclusive UTF-8 BYTE offsets
into the line, not string indexes (the unicode fixture pins this: an ASCII
token after Japanese text reports byte columns [35,38] where the JS string
index is [21,24]). The mapper remaps each offset to a UTF-16 code-unit
offset by walking the line's code points; an offset that does not land on a
code-point boundary routes the file to the Pierre fallback
(`invalid-span`), like every other validation failure.

None of the four architecture reports contradicts the sample. The reports do
not describe the difftastic JSON at all; the two traps above are documented
here because no report covers them.

### 5.2 Row classification over `aligned_lines`

`aligned_lines` covers the whole file as ordered `[lhs|null, rhs|null]`
rows, 0-based. Validate monotonicity: non-null values on each side must be
strictly increasing, and every 0..len-1 line of each file must appear
exactly once (fallback otherwise).

Build a novelty index from `chunks`: `(side, line_number) -> spans[]`.
Classify each aligned row:

- `[n, null]` -> deletion row (novel even without a chunk entry).
- `[null, m]` -> addition row (novel even without a chunk entry).
- `[n, m]` where either side has a chunk entry with nonempty `changes` ->
  modified pair (maps to one deletion + one addition, explicitly paired).
- `[n, m]` otherwise -> context row. Defensive check: old line n text must
  equal new line m text IGNORING WHITESPACE; mismatch -> fallback (would
  indicate a chunk entry the schema missed). Whitespace-blind because
  difftastic aligns reformatted/reindented lines as non-novel (whitespace is
  not a token); each side renders its own text from the full-file flat
  arrays, so split view shows the true per-side indentation. Cosmetic
  caveat: collapsed-gap expansion reads one side's source text, so a
  reindented line inside a collapsed region shows that side's indentation
  for both columns until difftastic-aware expansion is added.

A chunk entry where BOTH sides have empty `changes` (not observed; possible
under the unstable schema) classifies as context.

### 5.3 Index conventions

- difftastic `line_number` and `aligned_lines` values: 0-based file lines.
- Pierre `additionStart` / `deletionStart`: 1-based (= difftastic value +1).
- Pierre `additionLineIndex` / `deletionLineIndex`: 0-based indexes into the
  flat arrays. The mapper emits FULL files into
  `deletionLines` / `additionLines` and sets `isPartial: false`
  (Pierre's generated-from-contents convention), so LineIndex fields equal
  the 0-based file line numbers directly. No offset bookkeeping.
- `isPartial: false` also means the source-backed highlight plan (which is
  unified-diff-shaped and would reject difftastic hunks) never runs; full
  Shiki highlighting happens directly, and collapsed-gap expansion reads
  real file lines.

### 5.4 Hunk boundaries = difftastic chunks, context-merged

One difftastic chunk = one candidate hunk. For each chunk, take the min/max
aligned-row indexes touched by its entries, then extend by `context = 3`
aligned rows in each direction (clamped to the file). Merge candidates whose
extended row spans overlap or touch; each merged span becomes one `Hunk`.
This mirrors Pierre `parseDiffFromFile({ context: 3 })` merge behavior, so
`[` / `]` navigation density matches what users get from the Pierre engine.
Chunk order in the JSON is array order; hunks inherit it (no stable IDs
exist upstream; see Follow-ups).

Per hunk, walk its aligned-row span and emit `hunkContent` as maximal
homogeneous runs:

- context rows -> `ContextContent { type: "context", lines: k,
additionLineIndex, deletionLineIndex }` (both sides advance together;
  the old/new numbers may differ by a constant offset, which the render
  counters reproduce naturally).
- consecutive deletion rows -> `ChangeContent { deletions: k, additions: 0 }`.
- consecutive addition rows -> `ChangeContent { deletions: 0, additions: k }`.
- consecutive modified pairs -> `ChangeContent { deletions: k, additions: k }`.

The homogeneous-run rule is what carries difftastic's alignment into the
split layout: `buildSplitRows` pairs deletion i with addition i positionally
inside a change block, and inside a modified-pair run positional pairing IS
the difftastic alignment. A mixed run (del, pair, add) becomes three
adjacent blocks, so unpaired lines render against empty cells exactly as
difftastic aligns them. The row builders walk `hunkContent` entries without
assuming context/change alternation, so adjacent `ChangeContent` blocks are
legal. Stack layout consumes the same blocks (deletions then additions per
block), which interleaves modified pairs more tightly than git-style
all-dels-then-all-adds; that is intended.

Hunk numeric fields:

- `deletionStart` / `additionStart`: first row's 1-based line per side (for
  a side with no lines in the hunk, the running counter value, matching
  unified-diff convention).
- `deletionCount` / `additionCount`: per-side line counts including context
  (these feed `hunkLineRange`, so comment anchoring on context lines keeps
  working).
- `deletionLines` / `additionLines` (per-hunk counts): changed lines only.
- `collapsedBefore`: aligned rows between this hunk's span start and the
  previous hunk's span end (first hunk: rows before its span). Collapsed
  regions are context-only by construction, so `expandCollapsedRows`'s
  1:1 both-sides advance holds, and the trailing-gap
  `additionRemaining === deletionRemaining` invariant holds.
- `splitLineStart/Count`, `unifiedLineStart/Count`: cumulative render-row
  counts computed the same way Pierre does (split rows = context +
  max(d, a) per block; unified rows = context + d + a).
- `noEOFCRDeletions` / `noEOFCRAdditions`: from missing trailing newline in
  the respective body.
- `hunkContext`: leave undefined in v1 (`formatHunkHeader` computes
  `@@ -a,b +c,d @@` from the numeric fields).

### 5.5 Intraline novelty spans

The render path today carries intraline emphasis only as Pierre HAST
decorations (`data-diff-span`) flattened into emphasis-background
`RenderSpan`s; no numeric columns survive. difftastic gives numeric columns.
Bridge with the established sidecar precedent (`DiffLineMoveKinds`):

- New `DiffFile.noveltySpans?: DiffLineNoveltySpans` in
  `src/core/types.ts`: `{ additionLines: (ColumnSpan[] | undefined)[],
deletionLines: (ColumnSpan[] | undefined)[], additionWordLines?, deletionWordLines? }`,
  index-aligned with the flat metadata arrays, `ColumnSpan = [start, end]`
  0-based end-exclusive UTF-16 code-unit offsets, remapped by the mapper from
  the UTF-8 byte offsets in `changes[].start/end` (section 5.1). Sparse: only
  novel lines have entries; a modified line with empty `changes` gets `[]`
  (novel line, no emphasis). The `*WordLines` arrays carry the changed-word
  tier (section 5.6) in the same index space and the same sparse pattern.
- Render: in `src/ui/diff/pierre.ts`, where cells are built (the same sites
  that consult `lineMoveKinds`), apply
  `overlayNoveltySpans(spans, columnSpans, emphasis)`: split the flattened
  `RenderSpan[]` at the column boundaries and set the emphasis. The renderer
  receives code-unit spans (the mapper already remapped the byte offsets), so
  they slice line text and `RenderSpan.text` directly. A second
  `overlayNoveltySpans` pass adds the changed-word tier; because a
  `NoveltyEmphasis` field that is absent falls through to the underlying span,
  the attribute-only second pass keeps whatever colors the first one applied.
- The emphasis is a FOREGROUND, `theme.removedSignColor` or
  `theme.addedSignColor`, and nothing else: no bold on the novel span, no
  emphasis background, and no row tint (difftastic rows already suppress it).
  This is forced by the payload, not chosen for looks. difftastic emits one span
  per token and leaves the whitespace between them in no span at all, so a
  background paints with a hole at every gap; a foreground has no edges, which is
  why difft itself never shows the problem. `NoveltyEmphasis` carries no background
  field at all, so the type enforces this rather than a convention. There is exactly
  one rendering path, with no option to select another.
- For difftastic-engine files, pass Pierre `lineDiffType: "none"`
  (supported: `LineDiffTypes = 'word-alt' | 'word' | 'char' | 'none'`) so
  Pierre's own word-diff decorations do not double-highlight. Make
  `pierreRenderOptions` per-file instead of module-const.

### 5.6 Changed-word tier (word-level parity)

difftastic renders changed content in two tiers. `NovelWord` is bold plus
underline; `UnchangedPartOfNovelItem` is the plain novel color. Its JSON writer
keeps every span whose `MatchKind::is_novel()` holds, which covers both tiers,
then drops the tier label (difftastic issue #658). A payload's `changes` array
is therefore already the output of difftastic's word diff with only the tier
missing: the span boundaries are correct, and the tier is recoverable by
re-running the same decision.

The port lives in `src/core/engine/difftastic/novelWords.ts`
(`src/parse/syntax.rs` `split_atom_words`, plus `src/words.rs` and
`src/diff/lcs_diff.rs`, difftastic 0.69.0). One rule, no per-language cases:

1. **Scope.** Word splitting happens only when both sides are comment atoms or
   both are string atoms of the same kind (`ReplacedComment` / `ReplacedString`).
   Everything else, a changed identifier or keyword included, stays whole-atom
   novel with no inner emphasis.
2. **Tokenize** both atom contents with `split_words_and_numbers`: a token is a
   maximal run of `isAlphanumeric || '_'` characters, additionally split at every
   ASCII-digit / non-digit boundary; every other character is its own token.
   Iteration is by code point.
3. **Diff** the two token arrays with an LCS.
4. **Similarity gate** (`has_common_words`): count unchanged tokens that are not
   exactly a single space, and novel tokens on either side. Unless
   `unchanged > 2 && unchanged * 2 >= novel`, the whole atom is plain novel.
5. **Walk** the diff keeping a byte offset per side. A token present only on this
   side is the changed word, unless it is all whitespace, in which case
   difftastic emits no position for it at all.
6. **Render** the changed word bold plus underline over the novel foreground the
   first pass already applied.

The mapper (`map.ts`) supplies the atom contents, and the unit it must rebuild is
the ATOM, not the line: a comment or string atom routinely spans several lines,
and difftastic decides the gate once over the whole thing. Each side's body is
therefore addressed as one document (lines EOL-stripped, joined by one newline)
and every span is lifted into that space, so an atom's text is one slice however
many lines it covers.

Spans group into atom runs by one rule. difftastic emits one span per word for an
atom it word-split and one span per line for every other novel atom, so every
span of a single atom carries that atom's highlight, and the only source text
such a run steps over is a token `split_atom_words` dropped, which is a changed
whitespace-only word. A run therefore continues while the highlight matches and
the gap to the next span holds nothing but whitespace that is not a line break.

The line-break exclusion is what separates two atoms that merely sit on
consecutive lines, and it is safe because an in-atom line break is never bare.
`split_atom_words` positions each word with
`content_newlines.from_region_relative_to(pos[0], ...)[0]`, and the newline token
is the one token whose region crosses a line, so that `[0]` keeps a ZERO-WIDTH
position at the end of the line. `toDocumentSpan` restores that token's real
width, which is what lets a run cross into the next line; a line break with no
position of its own is difftastic saying the two spans are in different atoms.
Two adjacent line comments prove both halves at once: difft draws a changed word
only in the first, and joining them would carry the second past the gate difft
failed it on.

That same tiling fact settles step 1 from the other direction: a run of ONE span
is a whole-atom novel item, which is difftastic reporting that it did not
word-split the atom, so the decision is not re-run there. That is not only
faithfulness. It also bounds the work, since the rejected atoms are exactly the
long dissimilar ones the token diff is slowest on: a one-span 4000-word string
atom maps in 3 ms with the check and 4 s without it.

Runs pair positionally within the chunk entry each one begins in. An entry naming
both an lhs and an rhs line is difftastic's own statement that those two lines
are counterparts, and a multi-line atom begins on counterpart lines, so anchoring
to the starting entry keeps a mispairing from leaking past the line pair it
started on.

Two divergences, both measured against `difft 0.69.0` rather than assumed:

- **LCS tie-breaking.** difftastic runs Wu's O(NP) algorithm; the port uses the
  `diff` package's Myers implementation. Both produce a maximal common
  subsequence, so the gate counts agree, but when a token repeats the two can
  pair different occurrences and place a changed word one repeat away.
- **Multi-atom pairing.** The payload carries no atom identity, so an entry
  holding more than one changed atom pairs its runs positionally, in source
  order. When the two sides hold different numbers of atoms the surplus runs go
  unpaired and simply carry no changed word.

One further limit is not a divergence in the port but a ceiling in the payload:
`Highlight::from_match` maps `AtomKind::String(StringKind::Text)` to `normal`, so
plain-text and markdown bodies are word-split by difftastic yet indistinguishable
in the JSON from a changed identifier. The scope check keyed on `highlight`
therefore withholds emphasis there. That is the safe half of the ambiguity: it
can only withhold emphasis difftastic would draw, never invent emphasis it would
not.

The same boundary is why rendering the tier as bold PLUS underline is right
everywhere it can apply. difftastic underlines `NovelWord` only for
`FileFormat::SupportedLanguage`, bolding alone on plain text. But
`AtomKind::Comment` and `AtomKind::String(StringKind::StringLiteral)` come only
from the tree-sitter parser (`line_parser.rs` emits `AtomKind::Normal` and
nothing else), so a payload can never report `comment` or `string` for a file
difftastic parsed as text. Whenever the scope check accepts, difftastic's own
renderer is in the underlining branch.

Ground truth for every fixture named `novel-*` in `test/fixtures/difftastic/` is
the real `difft --color always --display side-by-side-show-both` output for the
same pair; the assertions reproduce which words it draws with SGR `1;4`.

### 5.7 File status handling

| difftastic `status`                     | Mapping                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `changed`                               | Full mapping as above. `ChangeTypes: "change"` (or the Pierre metadata's existing rename type, preserved from the baseline parse).                                                                                                                                                                                                                                                                         |
| `unchanged`                             | Structurally identical (difftastic may report this for changes it considers non-semantic even when git reported a textual diff). Keep the file with `hunks: []`, stats 0/0, and a per-file "no structural changes" marker rendered where an empty-hunk file renders today (mode-only changes already produce hunkless files). Verify `DiffPane`/geometry handle the hunkless case in the integration test. |
| `created` / `deleted`                   | Not reached in practice (dispatch skips `new`/`deleted` files, section 4). If difft reports it anyway for a `change`-typed file, treat as mapper validation failure -> Pierre fallback.                                                                                                                                                                                                                    |
| anything else (incl. any binary marker) | Fallback for the file.                                                                                                                                                                                                                                                                                                                                                                                     |

Renames: difftastic is invoked on the materialized old/new bodies; rename
bookkeeping (`previousPath`, `ChangeTypes` rename variants) stays with the
baseline Pierre/git parse and is not touched by the overlay.

## 6. Annotation semantics across engines

Anchor model recap: annotations are line-range based (`oldRange` /
`newRange`, 1-based inclusive); `hunkIndex` on `LiveComment` is frozen at
creation. Resolution paths: `findHunkIndexForLine` (line -> hunk via
`hunkLineRange`) and direct `hunkIndex` bounds-check, both against
`file.metadata.hunks`.

Rules:

- **Line anchors (`--old-line` / `--new-line`, `oldRange`/`newRange`) are
  engine-independent.** They are real 1-based file line numbers; difftastic
  hunks carry real per-side starts/counts, so `hunkLineRange` and
  `findHunkIndexForLine` resolve them against either engine unchanged. A
  line inside a difftastic hunk's context window anchors to that hunk; a
  line no hunk covers gets the existing "No {side} diff hunk covers line"
  error (difftastic hunks can cover fewer lines than Pierre's when difft
  suppresses non-semantic changes; that error is correct, not a bug).
- **Hunk-number anchors (`--hunk N` / `hunkNumber`) are engine-RELATIVE.**
  N resolves against the currently active engine's `file.metadata.hunks`,
  1-based at the CLI, converted once at the broker
  (`brokerServer.ts`: `hunkIndex = hunkNumber - 1`), exactly as today. No
  cross-engine translation table is built. The contract that makes this
  safe: `hunkt session review --json` summarizes the SAME array
  (`summarizeHunk` over `file.metadata.hunks`), so an agent that plans
  `--hunk N` from `review --json` output within a session always targets
  what it saw.
- `session review --json` additions (`src/session/types.ts`): per-file
  `engine: "pierre" | "difftastic"` (per-file because fallback is per-file)
  and a top-level `engine` echoing the configured engine. Document in
  `skills/` + agent-facing help: **agents should prefer line anchors**;
  hunk numbers are valid only against the engine/hunk list reported by the
  same session's `review --json`.
- Persisted/sidecar annotations (`--agent-context`) contain only line
  ranges, never hunk indexes; they re-anchor cleanly under either engine via
  the existing range-overlap machinery (`annotationOverlapsHunk`,
  `annotationAnchor`). The frozen `LiveComment.hunkIndex` remains advisory
  display state, as today; switching engines between sessions re-resolves
  placement from ranges.
- Inline note placement (`buildReviewRenderPlan`) matches anchor rows by
  side + line number, which difftastic rows carry; no change needed.

## 7. Testing plan

Fixtures (committed, so tests never need the difft binary):

- `test/fixtures/difftastic/before.js`
- `test/fixtures/difftastic/after.js`
- `test/fixtures/difftastic/sample-0.69.0.json` (captured output, verbatim)
- `test/fixtures/difftastic/unicode-{before,after}.js` +
  `unicode-0.69.0.json` (multibyte line; pins the byte-offset ground truth
  of section 5.1)
- `test/fixtures/difftastic/novel-*-{before,after}.{js,md}` +
  `novel-*-0.69.0.json`: one captured pair per rule in section 5.6, a changed
  word in a string and in a comment, a changed identifier (out of scope), a
  dissimilar string (gate rejects), a whitespace-only change (difft leaves a
  hole mid-atom), that hole alongside a real changed word, two atoms on one
  line, a per-atom gate verdict, a keyword next to a string, a multi-line
  comment, a rewritten multi-line comment difft word-split, one it rejected
  whole, a multibyte line, and a markdown Text atom.
- plus small synthetic JSON fixtures for edge cases the pair does not
  exercise (mixed del/pair/add run, added blank line, `unchanged` status,
  non-monotonic `aligned_lines`, schema violations).

Unit tests (colocated `*.test.ts`, repo convention):

- `src/core/engine/difftastic/map.test.ts` — the heart:
  - sample JSON + bodies -> exact `Hunk[]` (starts, counts, `hunkContent`
    runs, `collapsedBefore`, split/unified line counts).
  - blank-line addition (aligned-only, no chunk entry) becomes an addition
    row.
  - empty-`changes` side of a modified pair -> deletion row with `[]`
    novelty spans.
  - chunk merge: two chunks within 2x context rows -> one hunk; far apart ->
    two hunks with correct `collapsedBefore`.
  - context reconstruction equals file bodies; mismatch -> fallback result.
  - monotonicity/bounds violations -> fallback result, never throw.
  - `unchanged` status -> empty hunks; unknown status -> fallback.
  - noveltySpans arrays index-align with the flat line arrays, changed-word
    arrays included.
  - changed-word tier per rule in section 5.6, asserted against what difft
    itself draws bold plus underline for the same pair.
- `src/core/engine/difftastic/novelWords.test.ts` covers the ported decision in
  isolation: difftastic's own `split_words_and_numbers` unit cases, the scope
  gate, and the similarity gate's floor, ratio, and single-space exclusion.
- `src/core/engine/difftastic/schema.test.ts` — accepts the captured
  sample; rejects the synthetic malformed payloads; tolerates unknown extra
  keys.
- `src/core/engine/difftastic/exec.test.ts` — missing binary translated to
  the typed result (point `difft_path` at a nonexistent path); nonzero exit
  and timeout paths via a stub script fixture.
- `src/core/cli.test.ts` / `src/core/config.test.ts` additions — flag
  parsing (rejects unknown engine), TOML key + per-command section layering,
  `HUNKT_ENGINE` precedence below `--engine`, `difft_path` ignored from repo
  config with notice.
- `src/ui/diff/noveltySpans.test.ts` pins that `overlayNoveltySpans` splits spans at
  column boundaries, preserves text, and stacks a second attribute-only pass
  without losing the first pass's colors.
- `src/ui/diff/pierre.test.ts` addition: the row builders paint novel tokens with
  the sign foreground and no background at all, leaving the unspanned gap between
  two novel tokens unpainted, and mark the changed word bold plus underline over
  that foreground, through tab expansion.
- `src/ui/components/ui-components.test.tsx` addition: `DiffRowView` carries
  both attributes into the rendered terminal buffer and keeps row padding out
  of an underlined span.

Integration (one PTY case, only because it is cheap):

- `test/cli/engineDifftastic.test.ts` — skipped unless `difft` is on PATH.
  Runs `hunkt diff before.js after.js --engine difftastic` against the
  committed fixture pair, asserts the structural hunk renders and that
  `session review --json` reports `engine: "difftastic"`. A second
  non-skipped case runs with `difft_path` pointed at a nonexistent binary
  and asserts the one-line fallback notice + Pierre rendering (the fallback
  ladder is testable without difftastic installed).

Docs: `bun run generate:docs` after the config table change;
`scripts/generate-docs.test.ts` enforces coverage.

## 8. Follow-ups

- **Upstream difftastic asks** (Wilfred solicits JSON-consumer feedback in
  issues #216 / #916): stable hunk/chunk IDs in the JSON (today only array
  order exists, which blocks durable hunk anchors); the novelty tier label in
  the JSON (issue #658), which would retire the ported decision in section 5.6
  along with its divergences; an atom id per span, which would retire the
  positional multi-atom pairing and the per-line recovery of multi-line atoms; a
  schema version field so consumers can gate on payload shape instead of binary
  version.
- **Nix packaging**: add `difftastic` to `flake.nix` devShell so
  contributors get the pinned tested version; consider an optional wrapper
  that bakes `difft_path` for nix-installed hunk.
- **herdr split-screen live-annotation demo**: hunk review TUI with
  `engine = "difftastic"` in one pane, an agent adding structural-hunk
  comments over `hunkt session comment add` in the other.
- Watch-mode spawn cache keyed by (old content hash, new content hash) if
  per-file difft spawns measurably slow reloads.
- Consider difftastic for `patch`/`pager` inputs by reconstructing bodies
  from the patch when `isPartial` context suffices (needs design; excluded
  from v1).
